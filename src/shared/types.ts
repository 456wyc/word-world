export type EntryKind = 'word' | 'sentence';
export type Rating = 'known' | 'unsure' | 'unknown';
export type ReviewMode = 'subtitle' | 'barrage' | 'card';
export type ReviewPosition = 'bottom' | 'top';
export type ProviderMode = 'free' | 'ai';
export type WordSort = 'due' | 'created' | 'lookups';

export interface Sense {
  pos?: string;
  def: string;
}

export interface SrsState {
  stage: number;
  dueAt: number;
  lastReviewedAt?: number;
  reps: number;
  lapses: number;
  knownStreak: number;
}

export interface Entry {
  id: string;
  text: string;
  kind: EntryKind;
  translation: string;
  phonetic?: string;
  senses?: Sense[];
  example?: string;
  context?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  createdAt: number;
  updatedAt: number;
  lookups: number;
  note?: string;
  srs: SrsState;
}

export interface Settings {
  provider: {
    mode: ProviderMode;
    ai: { baseUrl: string; apiKey: string; model: string };
  };
  review: {
    enabled: boolean;
    intervalSec: number;
    displayMode: ReviewMode;
    position: ReviewPosition;
    durationSec: number;
    pausedHosts: string[];
  };
}

export interface SettingsPatch {
  provider?: {
    mode?: ProviderMode;
    ai?: Partial<Settings['provider']['ai']>;
  };
  review?: Partial<Settings['review']>;
}

export interface PublicSettings {
  provider: { mode: ProviderMode };
  review: Settings['review'];
}

export interface Stats {
  date: string;
  shown: number;
  reviewed: number;
  added: number;
}

export interface LookupPayload {
  translation: string;
  phonetic?: string;
  senses?: Sense[];
  example?: string;
}

export interface LookupRequest {
  text: string;
  context?: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

export type FallbackReason = 'ai-unconfigured' | 'ai-error' | 'rate-limit' | null;

export interface LookupResponse {
  entry: Entry;
  provider: ProviderMode;
  cached: boolean;
  fallbackReason: FallbackReason;
}

export interface ExportBundle {
  entries: Entry[];
  settings: Settings;
  exportedAt: number;
}

export type ErrorCode =
  | 'INVALID_PAYLOAD'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'CONFIG'
  | 'STORAGE'
  | 'UNKNOWN_MESSAGE';

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string } };

export type ExtMessage =
  | { type: 'lookup'; payload: LookupRequest }
  | { type: 'review:next'; payload: { host: string; recentIds: string[] } }
  | { type: 'review:rate'; payload: { id: string; rating: Rating } }
  | {
      type: 'words:list';
      payload: { query?: string; kind?: EntryKind; dueOnly?: boolean; sort?: WordSort };
    }
  | { type: 'words:update'; payload: { id: string; patch: { note?: string; translation?: string } } }
  | { type: 'words:delete'; payload: { id: string } }
  | { type: 'words:clear'; payload: Record<string, never> }
  | {
      type: 'words:import';
      payload: { entries: Entry[]; mode: 'merge' | 'replace' };
    }
  | { type: 'words:export'; payload: Record<string, never> }
  | { type: 'settings:get'; payload: Record<string, never> }
  | { type: 'settings:public'; payload: Record<string, never> }
  | { type: 'settings:update'; payload: SettingsPatch }
  | { type: 'provider:test'; payload: Record<string, never> }
  | { type: 'stats:get'; payload: Record<string, never> }
  | { type: 'review:preview'; payload: { mode: ReviewMode } };
