import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  DEFAULT_SETTINGS,
  MAX_DURATION_SEC,
  MAX_REVIEW_INTERVAL_SEC,
  MIN_DURATION_SEC,
  MIN_REVIEW_INTERVAL_SEC,
  SCHEMA_VERSION,
  STORAGE_KEYS,
} from '../shared/constants';
import type {
  Entry,
  EntryKind,
  ExportBundle,
  LookupPayload,
  PublicSettings,
  Settings,
  SettingsPatch,
  Stats,
  WordSort,
} from '../shared/types';
import { createSrsState } from './srs';
import { localDateKey } from '../shared/utils';

export interface CacheRecord {
  result: LookupPayload;
  cachedAt: number;
}

type EntryMap = Record<string, Entry>;
type CacheMap = Record<string, CacheRecord>;

async function readKey<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function writeKey(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

let writeChain: Promise<unknown> = Promise.resolve();

function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = writeChain.then(task, task);
  writeChain = run.catch(() => undefined);
  return run;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function mergeSettings(raw: unknown): Settings {
  const source = (raw ?? {}) as Record<string, any>;
  const defaults = DEFAULT_SETTINGS;
  const ai = source.provider?.ai ?? {};
  const review = source.review ?? {};

  return {
    provider: {
      mode: source.provider?.mode === 'ai' ? 'ai' : 'free',
      ai: {
        baseUrl:
          typeof ai.baseUrl === 'string' && ai.baseUrl ? ai.baseUrl : defaults.provider.ai.baseUrl,
        apiKey: typeof ai.apiKey === 'string' ? ai.apiKey : '',
        model: typeof ai.model === 'string' && ai.model ? ai.model : defaults.provider.ai.model,
      },
    },
    review: {
      enabled: typeof review.enabled === 'boolean' ? review.enabled : defaults.review.enabled,
      intervalSec: clampInt(
        review.intervalSec,
        defaults.review.intervalSec,
        MIN_REVIEW_INTERVAL_SEC,
        MAX_REVIEW_INTERVAL_SEC,
      ),
      displayMode: ['subtitle', 'barrage', 'card'].includes(review.displayMode)
        ? review.displayMode
        : defaults.review.displayMode,
      position: review.position === 'top' ? 'top' : 'bottom',
      durationSec: clampInt(
        review.durationSec,
        defaults.review.durationSec,
        MIN_DURATION_SEC,
        MAX_DURATION_SEC,
      ),
      pausedHosts: Array.isArray(review.pausedHosts)
        ? review.pausedHosts.filter((host: unknown): host is string => typeof host === 'string')
        : [],
    },
  };
}

export async function getSettings(): Promise<Settings> {
  return mergeSettings(await readKey<unknown>(STORAGE_KEYS.settings));
}

export function updateSettings(patch: SettingsPatch): Promise<Settings> {
  return serialize(async () => {
    const current = await getSettings();
    const next = mergeSettings({
      provider: {
        ...current.provider,
        ...patch.provider,
        ai: { ...current.provider.ai, ...patch.provider?.ai },
      },
      review: { ...current.review, ...patch.review },
    });
    await writeKey(STORAGE_KEYS.settings, next);
    return next;
  });
}

export async function getPublicSettings(): Promise<PublicSettings> {
  const settings = await getSettings();
  return { provider: { mode: settings.provider.mode }, review: settings.review };
}

export async function getEntriesMap(): Promise<EntryMap> {
  const raw = await readKey<unknown>(STORAGE_KEYS.entries);
  if (!isPlainObject(raw)) return {};
  const map: EntryMap = {};
  for (const [id, entry] of Object.entries(raw)) {
    if (isValidEntry(entry)) map[id] = entry;
  }
  return map;
}

async function writeEntriesMap(map: EntryMap): Promise<void> {
  await writeKey(STORAGE_KEYS.entries, map);
}

export async function getEntry(id: string): Promise<Entry | null> {
  const map = await getEntriesMap();
  return map[id] ?? null;
}

export function saveEntry(entry: Entry): Promise<void> {
  return serialize(async () => {
    const map = await getEntriesMap();
    map[entry.id] = entry;
    await writeEntriesMap(map);
  });
}

export async function listEntries(
  filter: { query?: string; kind?: EntryKind; dueOnly?: boolean; sort?: WordSort },
  now: number,
): Promise<Entry[]> {
  const map = await getEntriesMap();
  const query = filter.query?.trim().toLowerCase();
  let entries = Object.values(map);

  if (query) {
    entries = entries.filter(
      (entry) =>
        entry.text.toLowerCase().includes(query) ||
        entry.translation.toLowerCase().includes(query) ||
        (typeof entry.note === 'string' ? entry.note : '').toLowerCase().includes(query),
    );
  }
  if (filter.kind) entries = entries.filter((entry) => entry.kind === filter.kind);
  if (filter.dueOnly) entries = entries.filter((entry) => entry.srs.dueAt <= now);

  const sort = filter.sort ?? 'created';
  entries.sort((a, b) => {
    if (sort === 'due') return a.srs.dueAt - b.srs.dueAt;
    if (sort === 'lookups') return b.lookups - a.lookups;
    return b.createdAt - a.createdAt;
  });
  return entries;
}

export function deleteEntry(id: string): Promise<boolean> {
  return serialize(async () => {
    const map = await getEntriesMap();
    if (!map[id]) return false;
    delete map[id];
    await writeEntriesMap(map);
    return true;
  });
}

export function clearEntries(): Promise<void> {
  return serialize(async () => {
    await writeEntriesMap({});
  });
}

export function upsertLookup(
  input: {
    id: string;
    text: string;
    kind: EntryKind;
    payload: LookupPayload;
    context?: string;
    sourceUrl?: string;
    sourceTitle?: string;
  },
  now: number,
): Promise<{ entry: Entry; created: boolean }> {
  return serialize(async () => {
    const map = await getEntriesMap();
    const needle = input.text.toLowerCase();
    const existing = Object.values(map).find(
      (entry) => entry.kind === input.kind && entry.text.toLowerCase() === needle,
    );

    if (existing) {
      const entry: Entry = {
        ...existing,
        translation: input.payload.translation || existing.translation,
        phonetic: input.payload.phonetic ?? existing.phonetic,
        senses: input.payload.senses ?? existing.senses,
        example: input.payload.example ?? existing.example,
        context: input.context ?? existing.context,
        sourceUrl: input.sourceUrl ?? existing.sourceUrl,
        sourceTitle: input.sourceTitle ?? existing.sourceTitle,
        lookups: existing.lookups + 1,
        updatedAt: now,
        srs: { ...existing.srs, dueAt: Math.min(existing.srs.dueAt, now) },
      };
      map[entry.id] = entry;
      await writeEntriesMap(map);
      return { entry, created: false };
    }

    const entry: Entry = {
      id: input.id,
      text: input.text,
      kind: input.kind,
      translation: input.payload.translation,
      phonetic: input.payload.phonetic,
      senses: input.payload.senses,
      example: input.payload.example,
      context: input.context,
      sourceUrl: input.sourceUrl,
      sourceTitle: input.sourceTitle,
      createdAt: now,
      updatedAt: now,
      lookups: 1,
      srs: createSrsState(now),
    };
    map[entry.id] = entry;
    await writeEntriesMap(map);
    return { entry, created: true };
  });
}

export async function getStats(now: number): Promise<Stats> {
  const raw = await readKey<unknown>(STORAGE_KEYS.stats);
  const date = localDateKey(now);
  if (!isPlainObject(raw) || raw.date !== date) {
    return { date, shown: 0, reviewed: 0, added: 0 };
  }
  return {
    date,
    shown: isFiniteNumber(raw.shown) ? raw.shown : 0,
    reviewed: isFiniteNumber(raw.reviewed) ? raw.reviewed : 0,
    added: isFiniteNumber(raw.added) ? raw.added : 0,
  };
}

export function bumpStat(key: 'shown' | 'reviewed' | 'added', now: number): Promise<Stats> {
  return serialize(async () => {
    const stats = await getStats(now);
    stats[key] += 1;
    await writeKey(STORAGE_KEYS.stats, stats);
    return stats;
  });
}

export function trimCache(cache: CacheMap, max: number): CacheMap {
  if (!isPlainObject(cache)) return {};
  const keys = Object.keys(cache);
  if (keys.length <= max) return cache;
  keys
    .sort((a, b) => (cache[a]?.cachedAt ?? 0) - (cache[b]?.cachedAt ?? 0))
    .slice(0, keys.length - max)
    .forEach((key) => delete cache[key]);
  return cache;
}

function readCacheMap(raw: unknown): CacheMap {
  if (!isPlainObject(raw)) return {};
  const cache: CacheMap = {};
  for (const [key, record] of Object.entries(raw)) {
    if (!isPlainObject(record)) continue;
    if (!isFiniteNumber(record.cachedAt)) continue;
    if (!isPlainObject(record.result)) continue;
    cache[key] = { result: record.result as unknown as LookupPayload, cachedAt: record.cachedAt };
  }
  return cache;
}

export async function getCached(key: string, now: number): Promise<LookupPayload | null> {
  const cache = readCacheMap(await readKey<unknown>(STORAGE_KEYS.cache));
  const record = cache[key];
  if (!record || now - record.cachedAt > CACHE_TTL_MS) return null;
  return record.result;
}

export function setCached(
  key: string,
  result: LookupPayload,
  now: number,
): Promise<void> {
  return serialize(async () => {
    const cache = readCacheMap(await readKey<unknown>(STORAGE_KEYS.cache));
    cache[key] = { result, cachedAt: now };
    await writeKey(STORAGE_KEYS.cache, trimCache(cache, CACHE_MAX_ENTRIES));
  });
}

export function isValidEntry(raw: unknown): raw is Entry {
  if (!isPlainObject(raw)) return false;
  const entry = raw as Record<string, any>;
  return (
    typeof entry.id === 'string' &&
    entry.id.length > 0 &&
    typeof entry.text === 'string' &&
    entry.text.length > 0 &&
    (entry.kind === 'word' || entry.kind === 'sentence') &&
    typeof entry.translation === 'string' &&
    isFiniteNumber(entry.createdAt) &&
    isFiniteNumber(entry.updatedAt) &&
    typeof entry.lookups === 'number' &&
    isPlainObject(entry.srs) &&
    typeof entry.srs.stage === 'number' &&
    isFiniteNumber(entry.srs.dueAt) &&
    typeof entry.srs.reps === 'number'
  );
}

export function importEntries(
  raw: unknown[],
  mode: 'merge' | 'replace',
): Promise<{ imported: number; skipped: number }> {
  return serialize(async () => {
    const map: EntryMap = mode === 'replace' ? {} : await getEntriesMap();
    let imported = 0;
    let skipped = 0;

    for (const candidate of raw) {
      if (!isValidEntry(candidate)) {
        skipped += 1;
        continue;
      }
      const existing = map[candidate.id];
      if (existing && existing.updatedAt > candidate.updatedAt) {
        skipped += 1;
        continue;
      }
      map[candidate.id] = candidate;
      imported += 1;
    }

    await writeEntriesMap(map);
    return { imported, skipped };
  });
}

export async function buildExport(now: number): Promise<ExportBundle> {
  const map = await getEntriesMap();
  const settings = await getSettings();
  return {
    entries: Object.values(map),
    settings: {
      ...settings,
      provider: { ...settings.provider, ai: { ...settings.provider.ai, apiKey: '' } },
    },
    exportedAt: now,
  };
}

export async function ensureSchema(): Promise<void> {
  const version = await readKey<number>(STORAGE_KEYS.schema);
  if (version !== SCHEMA_VERSION) {
    await writeKey(STORAGE_KEYS.schema, SCHEMA_VERSION);
  }
}
