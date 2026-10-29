import { getCached, setCached } from '../storage';
import type {
  EntryKind,
  FallbackReason,
  LookupPayload,
  ProviderMode,
  Settings,
} from '../../shared/types';
import { classifySelection, normalizeText } from '../../shared/utils';
import { ProviderError } from '../../shared/http';
import { aiLookup } from './ai';
import { freeLookup } from './free';

export { aiLookup, parseAiPayload } from './ai';
export { freeLookup, translateText } from './free';
export { ProviderError } from '../../shared/http';

export interface LookupOutcome {
  payload: LookupPayload;
  provider: ProviderMode;
  cached: boolean;
  fallbackReason: FallbackReason;
}

async function fallbackToFree(
  text: string,
  kind: EntryKind,
  reason: FallbackReason,
  now: number,
): Promise<LookupOutcome> {
  const payload = await freeLookup(text, kind);
  await setCached(`free:${text.toLowerCase()}`, payload, now);
  return { payload, provider: 'free', cached: false, fallbackReason: reason };
}

export async function resolveLookup(
  rawText: string,
  context: string | undefined,
  settings: Settings,
): Promise<LookupOutcome> {
  const text = normalizeText(rawText);
  const kind = classifySelection(text);
  const now = Date.now();
  const mode = settings.provider.mode;
  const cacheKey = `${mode}:${text.toLowerCase()}`;

  const cached = await getCached(cacheKey, now);
  if (cached) {
    return { payload: cached, provider: mode, cached: true, fallbackReason: null };
  }

  if (mode === 'ai') {
    if (!settings.provider.ai.apiKey) {
      return fallbackToFree(text, kind, 'ai-unconfigured', now);
    }
    try {
      const payload = await aiLookup(text, kind, context, settings.provider.ai);
      await setCached(cacheKey, payload, now);
      return { payload, provider: 'ai', cached: false, fallbackReason: null };
    } catch {
      try {
        return await fallbackToFree(text, kind, 'ai-error', now);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('NETWORK', '查询失败，请稍后重试');
      }
    }
  }

  try {
    const payload = await freeLookup(text, kind);
    await setCached(cacheKey, payload, now);
    return { payload, provider: 'free', cached: false, fallbackReason: null };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('NETWORK', '查询失败，请稍后重试');
  }
}
