import type { Settings } from './types';

export const STORAGE_KEYS = {
  entries: 'ww.entries.v1',
  settings: 'ww.settings.v1',
  stats: 'ww.stats.v1',
  cache: 'ww.cache.v1',
  schema: 'ww.schema',
} as const;

export const SCHEMA_VERSION = 1;
export const MAX_SELECTION_LENGTH = 400;
export const MAX_CONTEXT_LENGTH = 300;
export const MAX_SENSES = 4;
export const REQUEST_TIMEOUT_MS = 8000;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 500;
export const MIN_REVIEW_INTERVAL_SEC = 60;
export const MAX_REVIEW_INTERVAL_SEC = 1800;
export const MIN_DURATION_SEC = 4;
export const MAX_DURATION_SEC = 30;
export const SKIP_RETRY_MS = 30_000;
export const RECENT_SHOWN_LIMIT = 5;

export const WORD_INTERVALS_MS = [
  0,
  86_400_000,
  3 * 86_400_000,
  7 * 86_400_000,
  16 * 86_400_000,
  35 * 86_400_000,
];

export const SENT_INTERVALS_MS = [0, 86_400_000, 4 * 86_400_000, 15 * 86_400_000];

export const DEFAULT_SETTINGS: Settings = {
  provider: {
    mode: 'free',
    ai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  },
  review: {
    enabled: true,
    intervalSec: 180,
    displayMode: 'subtitle',
    position: 'bottom',
    durationSec: 8,
    pausedHosts: [],
  },
};
