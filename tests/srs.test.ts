import { describe, expect, it } from 'vitest';
import { createSrsState, nextIntervalMs, pickNext, rateEntry } from '../src/background/srs';
import type { Entry, EntryKind } from '../src/shared/types';

const NOW = 1_700_000_000_000;

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: overrides.id ?? 'id-1',
    text: overrides.text ?? 'hello',
    kind: overrides.kind ?? 'word',
    translation: '你好',
    createdAt: NOW,
    updatedAt: NOW,
    lookups: 1,
    srs: createSrsState(NOW),
    ...overrides,
  };
}

describe('createSrsState', () => {
  it('新词 10 分钟后到期', () => {
    const state = createSrsState(NOW);
    expect(state).toMatchObject({ stage: 0, reps: 0, lapses: 0, knownStreak: 0 });
    expect(state.dueAt).toBe(NOW + 10 * 60_000);
  });
});

describe('rateEntry', () => {
  it('认识推进 stage 并按 1 天安排', () => {
    const next = rateEntry(makeEntry(), 'known', NOW);
    expect(next.srs.stage).toBe(1);
    expect(next.srs.knownStreak).toBe(1);
    expect(next.srs.dueAt).toBe(NOW + 86_400_000);
  });

  it('单词 stage 封顶 5，间隔 35 天', () => {
    const entry = makeEntry({ srs: { ...createSrsState(NOW), stage: 5 } });
    const next = rateEntry(entry, 'known', NOW);
    expect(next.srs.stage).toBe(5);
    expect(next.srs.dueAt).toBe(NOW + 35 * 86_400_000);
  });

  it('模糊不改变 stage，1 小时后到期', () => {
    const entry = makeEntry({ srs: { ...createSrsState(NOW), stage: 2 } });
    const next = rateEntry(entry, 'unsure', NOW);
    expect(next.srs.stage).toBe(2);
    expect(next.srs.knownStreak).toBe(0);
    expect(next.srs.dueAt).toBe(NOW + 60 * 60_000);
  });

  it('不认识降低 stage 并累计 lapses', () => {
    const entry = makeEntry({ srs: { ...createSrsState(NOW), stage: 2, lapses: 1 } });
    const next = rateEntry(entry, 'unknown', NOW);
    expect(next.srs.stage).toBe(1);
    expect(next.srs.lapses).toBe(2);
    expect(next.srs.dueAt).toBe(NOW + 10 * 60_000);
  });

  it('句子阶梯封顶 3（15 天）', () => {
    const entry = makeEntry({ kind: 'sentence', srs: { ...createSrsState(NOW), stage: 3 } });
    expect(rateEntry(entry, 'known', NOW).srs.dueAt).toBe(NOW + 15 * 86_400_000);
  });

  it('stage 0 不认识仍为 0，累计 lapses，10 分钟后到期', () => {
    const entry = makeEntry({ srs: { ...createSrsState(NOW), stage: 0, lapses: 0 } });
    const next = rateEntry(entry, 'unknown', NOW);
    expect(next.srs.stage).toBe(0);
    expect(next.srs.lapses).toBe(1);
    expect(next.srs.dueAt).toBe(NOW + 10 * 60_000);
    expect(next.updatedAt).toBe(NOW);
  });

  it('不修改传入的条目', () => {
    const entry = makeEntry({
      srs: { ...createSrsState(NOW), stage: 2, reps: 3, knownStreak: 2 },
    });
    const snapshot = structuredClone(entry);

    const next = rateEntry(entry, 'known', NOW);

    expect(entry).toEqual(snapshot);
    expect(entry.srs).toEqual(snapshot.srs);
    expect(entry.updatedAt).toBe(snapshot.updatedAt);
    expect(next).not.toBe(entry);
    expect(next.srs).not.toBe(entry.srs);
  });

  // [kind, stage before 认识, 期望间隔天数]
  const LADDER: Array<[EntryKind, number, number]> = [
    ['word', 2, 7],
    ['word', 3, 16],
    ['word', 4, 35],
    ['sentence', 0, 1],
    ['sentence', 1, 4],
    ['sentence', 2, 15],
  ];

  it.each(LADDER)('%s 从 stage %d 认识后按 %d 天安排', (kind, from, days) => {
    const entry = makeEntry({ kind, srs: { ...createSrsState(NOW), stage: from } });
    const next = rateEntry(entry, 'known', NOW);
    expect(next.srs.stage).toBe(from + 1);
    expect(next.srs.dueAt).toBe(NOW + days * 86_400_000);
  });
});

describe('pickNext', () => {
  it('返回最早期到期的条目', () => {
    const early = makeEntry({ id: 'a', srs: { ...createSrsState(NOW), dueAt: NOW - 5000 } });
    const late = makeEntry({ id: 'b', srs: { ...createSrsState(NOW), dueAt: NOW - 1000 } });
    expect(pickNext([late, early], NOW)?.id).toBe('a');
  });

  it('跳过未到期与最近展示过的条目', () => {
    const due = makeEntry({ id: 'a', srs: { ...createSrsState(NOW), dueAt: NOW - 1000 } });
    const notDue = makeEntry({ id: 'b', srs: { ...createSrsState(NOW), dueAt: NOW + 1000 } });
    expect(pickNext([due, notDue], NOW, ['a'])).toBeNull();
  });

  it('跳过 recentIds 中更早到期的条目，返回次早的到期条目', () => {
    const moreOverdue = makeEntry({ id: 'recent', srs: { ...createSrsState(NOW), dueAt: NOW - 10_000 } });
    const lessOverdue = makeEntry({ id: 'candidate', srs: { ...createSrsState(NOW), dueAt: NOW - 1000 } });

    const picked = pickNext([moreOverdue, lessOverdue], NOW, ['recent']);

    expect(picked).not.toBeNull();
    expect(picked?.id).toBe('candidate');
  });
});

describe('nextIntervalMs', () => {
  it('越界 stage 取最大档', () => {
    expect(nextIntervalMs('word', 99)).toBe(35 * 86_400_000);
    expect(nextIntervalMs('sentence', 99)).toBe(15 * 86_400_000);
  });

  it('范围内的中间档位返回对应间隔', () => {
    expect(nextIntervalMs('word', 3)).toBe(7 * 86_400_000);
    expect(nextIntervalMs('sentence', 2)).toBe(4 * 86_400_000);
  });
});
