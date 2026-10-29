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

const RATINGS: readonly Rating[] = ['known', 'unsure', 'unknown'];

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
    switch (message.type) {
      case 'lookup': {
        const text = normalizeText(message.payload.text);
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
        const settings = await getSettings();
        if (!settings.review.enabled) return ok(null);
        if (settings.review.pausedHosts.includes(message.payload.host)) return ok(null);
        const entries = Object.values(await getEntriesMap());
        const entry: Entry | null = pickNext(entries, now, message.payload.recentIds);
        if (!entry) return ok(null);
        await bumpStat('shown', now);
        return ok(entry);
      }

      case 'review:rate': {
        const entry = await getEntry(message.payload.id);
        if (!entry) return fail('NOT_FOUND', '词条不存在');
        if (!RATINGS.includes(message.payload.rating)) {
          return fail('INVALID_PAYLOAD', '评分无效');
        }
        const updated = rateEntry(entry, message.payload.rating, now);
        await saveEntry(updated);
        await bumpStat('reviewed', now);
        return ok({ entry: updated, dueAt: updated.srs.dueAt });
      }

      case 'words:list': {
        return ok(await listEntries(message.payload, now));
      }

      case 'words:update': {
        const entry = await getEntry(message.payload.id);
        if (!entry) return fail('NOT_FOUND', '词条不存在');
        const note = message.payload.patch.note;
        if (note !== undefined && note.length > 1000) {
          return fail('INVALID_PAYLOAD', '备注过长');
        }
        const updated: Entry = {
          ...entry,
          note: note !== undefined ? note : entry.note,
          translation: message.payload.patch.translation?.trim() || entry.translation,
          updatedAt: now,
        };
        await saveEntry(updated);
        return ok(updated);
      }

      case 'words:delete': {
        const deleted = await deleteEntry(message.payload.id);
        return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '词条不存在');
      }

      case 'words:clear': {
        await clearEntries();
        return ok({ cleared: true });
      }

      case 'words:import': {
        if (!Array.isArray(message.payload.entries)) {
          return fail('INVALID_PAYLOAD', '导入数据格式错误');
        }
        return ok(await importEntries(message.payload.entries, message.payload.mode));
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
