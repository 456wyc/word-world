import { MAX_CONTEXT_LENGTH } from '../shared/constants';
import { ProviderError } from '../shared/http';
import type {
  Entry,
  ErrorCode,
  ExtMessage,
  LookupResponse,
  Rating,
  Result,
  Stats,
} from '../shared/types';
import {
  classifySelection,
  isValidSelection,
  normalizeText,
  sanitizeHttpUrl,
  truncate,
} from '../shared/utils';
import { aiLookup, freeLookup, resolveLookup } from './providers';
import { pickNext, rateEntry } from './srs';
import {
  buildExport,
  bumpStat,
  clearEntries,
  deleteEntry,
  getEntriesMap,
  getEntry,
  getPublicSettings,
  getSettings,
  getStats,
  importEntries,
  listEntries,
  saveEntry,
  updateSettings,
  upsertLookup,
} from './storage';

const RATINGS: readonly string[] = ['known', 'unsure', 'unknown'];

function isRating(value: string): value is Rating {
  return RATINGS.includes(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function fail(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function errorToResult(error: unknown): Result<never> {
  if (error instanceof ProviderError) return fail(error.code, error.message);
  return fail('NETWORK', '操作失败，请稍后重试');
}

export async function handleMessage(
  message: ExtMessage,
  now = Date.now(),
): Promise<Result<unknown>> {
  try {
    const payload: unknown = message.payload;
    if (!isPlainObject(payload)) {
      return fail('INVALID_PAYLOAD', '消息载荷格式错误');
    }

    switch (message.type) {
      case 'lookup': {
        const rawText = payload.text;
        if (typeof rawText !== 'string') {
          return fail('INVALID_PAYLOAD', '选中内容为空或过长');
        }
        const text = normalizeText(rawText);
        if (!isValidSelection(text)) {
          return fail('INVALID_PAYLOAD', '选中内容为空或过长');
        }
        const context = message.payload.context
          ? truncate(normalizeText(message.payload.context), MAX_CONTEXT_LENGTH)
          : undefined;
        const settings = await getSettings();
        const outcome = await resolveLookup(text, context, settings);
        const sourceTitle = message.payload.sourceTitle
          ? truncate(message.payload.sourceTitle, 200)
          : undefined;
        const { entry, created } = await upsertLookup(
          {
            id: crypto.randomUUID(),
            text,
            kind: classifySelection(text),
            payload: outcome.payload,
            context,
            sourceUrl: sanitizeHttpUrl(message.payload.sourceUrl),
            sourceTitle,
          },
          now,
        );
        if (created) await bumpStat('added', now);
        const response: LookupResponse = {
          entry,
          provider: outcome.provider,
          cached: outcome.cached,
          fallbackReason: outcome.fallbackReason,
        };
        return ok(response);
      }

      case 'review:next': {
        const rawHost = payload.host;
        if (rawHost !== undefined && typeof rawHost !== 'string') {
          return fail('INVALID_PAYLOAD', '站点信息无效');
        }
        const host = typeof rawHost === 'string' ? rawHost : '';
        const recentIds = Array.isArray(payload.recentIds)
          ? payload.recentIds.filter((id): id is string => typeof id === 'string')
          : [];
        const settings = await getSettings();
        if (!settings.review.enabled) return ok(null);
        if (settings.review.pausedHosts.includes(host)) return ok(null);
        const entries = Object.values(await getEntriesMap());
        const entry: Entry | null = pickNext(entries, now, recentIds);
        if (!entry) return ok(null);
        await bumpStat('shown', now);
        return ok(entry);
      }

      case 'review:rate': {
        const id = payload.id;
        if (typeof id !== 'string') {
          return fail('INVALID_PAYLOAD', '词条 ID 无效');
        }
        const rating = payload.rating;
        if (typeof rating !== 'string') {
          return fail('INVALID_PAYLOAD', '评分无效');
        }
        const entry = await getEntry(id);
        if (!entry) return fail('NOT_FOUND', '词条不存在');
        if (!isRating(rating)) {
          return fail('INVALID_PAYLOAD', '评分无效');
        }
        const updated = rateEntry(entry, rating, now);
        await saveEntry(updated);
        await bumpStat('reviewed', now);
        return ok({ entry: updated, dueAt: updated.srs.dueAt });
      }

      case 'words:list': {
        return ok(await listEntries(message.payload, now));
      }

      case 'words:update': {
        const id = payload.id;
        if (typeof id !== 'string') {
          return fail('INVALID_PAYLOAD', '词条 ID 无效');
        }
        const patch = payload.patch;
        if (!isPlainObject(patch)) {
          return fail('INVALID_PAYLOAD', '更新内容无效');
        }
        const entry = await getEntry(id);
        if (!entry) return fail('NOT_FOUND', '词条不存在');
        const rawNote = patch.note;
        if (rawNote !== undefined && typeof rawNote !== 'string') {
          return fail('INVALID_PAYLOAD', '备注无效');
        }
        const note = typeof rawNote === 'string' ? rawNote : undefined;
        if (note !== undefined && note.length > 1000) {
          return fail('INVALID_PAYLOAD', '备注过长');
        }
        const rawTranslation = patch.translation;
        if (rawTranslation !== undefined && typeof rawTranslation !== 'string') {
          return fail('INVALID_PAYLOAD', '译义无效');
        }
        const translation = typeof rawTranslation === 'string' ? rawTranslation : undefined;
        const updated: Entry = {
          ...entry,
          note: note !== undefined ? note : entry.note,
          translation: translation?.trim() || entry.translation,
          updatedAt: now,
        };
        await saveEntry(updated);
        return ok(updated);
      }

      case 'words:delete': {
        const id = payload.id;
        if (typeof id !== 'string') {
          return fail('INVALID_PAYLOAD', '词条 ID 无效');
        }
        const deleted = await deleteEntry(id);
        return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '词条不存在');
      }

      case 'words:clear': {
        await clearEntries();
        return ok({ cleared: true });
      }

      case 'words:import': {
        const entries = payload.entries;
        const mode = payload.mode;
        if (!Array.isArray(entries)) {
          return fail('INVALID_PAYLOAD', '导入数据格式错误');
        }
        if (mode !== 'merge' && mode !== 'replace') {
          return fail('INVALID_PAYLOAD', '导入模式无效');
        }
        return ok(await importEntries(entries, mode));
      }

      case 'words:export': {
        return ok(await buildExport(now));
      }

      case 'settings:get': {
        return ok(await getSettings());
      }

      case 'settings:public': {
        return ok(await getPublicSettings());
      }

      case 'settings:update': {
        return ok(await updateSettings(message.payload));
      }

      case 'stats:get': {
        const stats: Stats = await getStats(now);
        return ok(stats);
      }

      case 'provider:test': {
        const settings = await getSettings();
        if (settings.provider.mode === 'ai') {
          const payload = await aiLookup('hello', 'word', undefined, settings.provider.ai);
          return ok({ provider: 'ai', sample: payload.translation });
        }
        const payload = await freeLookup('hello', 'word');
        return ok({ provider: 'free', sample: payload.translation });
      }

      default:
        return fail('UNKNOWN_MESSAGE', '未知消息类型');
    }
  } catch (error) {
    return errorToResult(error);
  }
}
