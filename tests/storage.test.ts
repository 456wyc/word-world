import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeMock } from './helpers/chrome';
import {
  buildExport,
  bumpStat,
  getCached,
  getSettings,
  importEntries,
  setCached,
  trimCache,
  upsertLookup,
  isValidEntry,
} from '../src/background/storage';
import { CACHE_MAX_ENTRIES, DEFAULT_SETTINGS, STORAGE_KEYS } from '../src/shared/constants';
import type { Entry } from '../src/shared/types';

const NOW = 1_700_000_000_000;

function sampleEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    text: 'hello',
    kind: 'word',
    translation: '你好',
    createdAt: NOW,
    updatedAt: NOW,
    lookups: 1,
    srs: { stage: 0, dueAt: NOW + 600_000, reps: 0, lapses: 0, knownStreak: 0 },
    ...overrides,
  };
}

let store: Record<string, unknown>;

beforeEach(() => {
  store = installChromeMock().store;
});

describe('settings', () => {
  it('无存储时返回默认设置', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('合并时钳制范围并丢弃未知值', async () => {
    store[STORAGE_KEYS.settings] = {
      review: { intervalSec: 5, displayMode: 'bogus', durationSec: 99, pausedHosts: ['a.com', 3] },
      provider: { mode: 'ai' },
    };
    const settings = await getSettings();
    expect(settings.review.intervalSec).toBe(60);
    expect(settings.review.displayMode).toBe('subtitle');
    expect(settings.review.durationSec).toBe(30);
    expect(settings.review.pausedHosts).toEqual(['a.com']);
    expect(settings.provider.ai.model).toBe(DEFAULT_SETTINGS.provider.ai.model);
  });
});

describe('stats', () => {
  it('跨天重置计数', async () => {
    store[STORAGE_KEYS.stats] = { date: '2000-01-01', shown: 9, reviewed: 9, added: 9 };
    const stats = await bumpStat('shown', NOW);
    expect(stats.shown).toBe(1);
    expect(stats.reviewed).toBe(0);
    expect(stats.date).not.toBe('2000-01-01');
  });
});

describe('cache', () => {
  it('命中未过期缓存', async () => {
    await setCached('free:hello', { translation: '你好' }, NOW);
    expect(await getCached('free:hello', NOW + 1000)).toEqual({ translation: '你好' });
  });

  it('过期缓存返回 null', async () => {
    await setCached('free:hello', { translation: '你好' }, NOW);
    expect(await getCached('free:hello', NOW + 8 * 86_400_000)).toBeNull();
  });

  it('trimCache 淘汰最旧条目', () => {
    const cache = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `k${i}`,
        { result: { translation: 'x' }, cachedAt: i },
      ]),
    );
    const trimmed = trimCache(cache, 3);
    expect(Object.keys(trimmed).sort()).toEqual(['k2', 'k3', 'k4']);
    expect(CACHE_MAX_ENTRIES).toBe(500);
  });
});

describe('entries', () => {
  it('首次查询创建词条', async () => {
    const result = await upsertLookup(
      { id: 'e1', text: 'hello', kind: 'word', payload: { translation: '你好' } },
      NOW,
    );
    expect(result.created).toBe(true);
    expect(result.entry.lookups).toBe(1);
    expect(result.entry.srs.dueAt).toBe(NOW + 600_000);
  });

  it('重复查询累加 lookups 并将 dueAt 提前到当前时间', async () => {
    await upsertLookup(
      { id: 'e1', text: 'hello', kind: 'word', payload: { translation: '你好' } },
      NOW,
    );
    const later = NOW + 120_000;
    const result = await upsertLookup(
      { id: 'e2', text: 'Hello', kind: 'word', payload: { translation: '喂' } },
      later,
    );
    expect(result.created).toBe(false);
    expect(result.entry.id).toBe('e1');
    expect(result.entry.lookups).toBe(2);
    expect(result.entry.srs.dueAt).toBe(later);
  });

  it('导入时跳过非法条目并统计', async () => {
    const result = await importEntries(
      [sampleEntry({ id: 'ok' }), { id: 'bad' }, null],
      'merge',
    );
    expect(result).toEqual({ imported: 1, skipped: 2 });
  });

  it('isValidEntry 校验必需字段', () => {
    expect(isValidEntry(sampleEntry())).toBe(true);
    expect(isValidEntry({ ...sampleEntry(), srs: {} })).toBe(false);
  });

  it('导出时移除 API Key', async () => {
    store[STORAGE_KEYS.settings] = {
      ...DEFAULT_SETTINGS,
      provider: { mode: 'ai', ai: { baseUrl: 'https://x/v1', apiKey: 'secret', model: 'm' } },
    };
    const bundle = await buildExport(NOW);
    expect(bundle.settings.provider.ai.apiKey).toBe('');
    expect(bundle.exportedAt).toBe(NOW);
  });
});
