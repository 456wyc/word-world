import { MAX_CONTEXT_LENGTH, MAX_SELECTION_LENGTH } from './constants';
import type { Entry, EntryKind } from './types';

export function normalizeText(input: string): string {
  return input.replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function containsCJK(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}

export function isValidSelection(text: string): boolean {
  const normalized = normalizeText(text);
  return normalized.length > 0 && normalized.length <= MAX_SELECTION_LENGTH;
}

export function classifySelection(input: string): EntryKind {
  const text = normalizeText(input);
  if (!text || containsCJK(text)) return 'sentence';
  if (!/^[A-Za-z][A-Za-z'’\-]*(\s+[A-Za-z][A-Za-z'’\-]*)?$/.test(text)) return 'sentence';
  return 'word';
}

export function isDue(entry: Entry, now: number): boolean {
  return entry.srs.dueAt <= now;
}

export function formatNextReview(dueAt: number, now: number): string {
  const diff = Math.max(0, dueAt - now);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

export function localDateKey(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
}

export function sanitizeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export function extractContext(raw: string, selected: string, max = MAX_CONTEXT_LENGTH): string {
  const text = normalizeText(raw);
  const index = text.indexOf(normalizeText(selected));
  if (index < 0) return truncate(text, max);
  const half = Math.max(0, Math.floor((max - selected.length) / 2));
  const start = Math.max(0, index - half);
  return truncate(text.slice(start, index + selected.length + half), max);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
