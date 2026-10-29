import { SENT_INTERVALS_MS, WORD_INTERVALS_MS } from '../shared/constants';
import type { Entry, EntryKind, Rating, SrsState } from '../shared/types';

const WORD_MAX_STAGE = 5;
const SENT_MAX_STAGE = 3;
const NEW_DELAY_MS = 10 * 60_000;
const UNSURE_DELAY_MS = 60 * 60_000;
const AGAIN_DELAY_MS = 10 * 60_000;

function maxStage(kind: EntryKind): number {
  return kind === 'word' ? WORD_MAX_STAGE : SENT_MAX_STAGE;
}

function intervals(kind: EntryKind): number[] {
  return kind === 'word' ? WORD_INTERVALS_MS : SENT_INTERVALS_MS;
}

export function createSrsState(now: number): SrsState {
  return { stage: 0, dueAt: now + NEW_DELAY_MS, reps: 0, lapses: 0, knownStreak: 0 };
}

export function rateEntry(entry: Entry, rating: Rating, now: number): Entry {
  const srs: SrsState = {
    ...entry.srs,
    lastReviewedAt: now,
    reps: entry.srs.reps + 1,
  };

  if (rating === 'known') {
    srs.stage = Math.min(entry.srs.stage + 1, maxStage(entry.kind));
    srs.knownStreak = entry.srs.knownStreak + 1;
    srs.dueAt = now + intervals(entry.kind)[srs.stage];
  } else if (rating === 'unsure') {
    srs.knownStreak = 0;
    srs.dueAt = now + UNSURE_DELAY_MS;
  } else {
    srs.stage = Math.max(0, entry.srs.stage - 1);
    srs.knownStreak = 0;
    srs.lapses = entry.srs.lapses + 1;
    srs.dueAt = now + AGAIN_DELAY_MS;
  }

  return { ...entry, srs, updatedAt: now };
}

export function pickNext(entries: Entry[], now: number, recentIds: string[] = []): Entry | null {
  const recent = new Set(recentIds);
  const due = entries
    .filter((entry) => entry.srs.dueAt <= now && !recent.has(entry.id))
    .sort((a, b) => a.srs.dueAt - b.srs.dueAt);
  return due[0] ?? null;
}

export function nextIntervalMs(kind: EntryKind, stage: number): number {
  const list = intervals(kind);
  return list[Math.min(stage, maxStage(kind))] ?? 0;
}
