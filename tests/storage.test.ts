import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeMock } from './helpers/chrome';
import {
  buildExport,
  bumpStat,
  clearEntries,
  deleteEntry,
  ensureSchema,
  getCached,
  getEntriesMap,
  getPublicSettings,
  getSettings,
  getStats,
  importEntries,
  isValidEntry,
  listEntries,
  mergeSettings,
  saveEntry,
  setCached,
  trimCache,
  upsertLookup,
} from '../src/background/storage';
import {
  CACHE_MAX_ENTRIES,
  DEFAULT_SETTINGS,
  SCHEMA_VERSION,
  STORAGE_KEYS,
} from '../src/shared/constants';
import { localDateKey } from '../src/shared/utils';
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

function dueEntry(id: string, dueAt: number, overrides: Partial<Entry> = {}): Entry {
  return sampleEntry({
    id,
    text: id,
    translation: `译-${id}`,
    createdAt: NOW,
    updatedAt: NOW,
    srs: { stage: 0, dueAt, reps: 0, lapses: 0, knownStreak: 0 },
    ...overrides,
  });
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

describe('mergeSettings', () => {
  it('返回全新对象图，修改结果不影响后续合并', () => {
    const first = mergeSettings(undefined);
    first.review.pausedHosts.push('evil.example');
    first.review.intervalSec = 5;
    first.provider.ai.apiKey = 'leak';

    const second = mergeSettings(undefined);
    expect(second.review.pausedHosts).toEqual([]);
    expect(second.review.intervalSec).toBe(DEFAULT_SETTINGS.review.intervalSec);
    expect(second.provider.ai.apiKey).toBe('');
    expect(DEFAULT_SETTINGS.review.pausedHosts).toEqual([]);
  });

  it('钳制到合法区间', () => {
    expect(mergeSettings({ review: { intervalSec: 59 } }).review.intervalSec).toBe(60);
    expect(mergeSettings({ review: { intervalSec: 1801 } }).review.intervalSec).toBe(1800);
    expect(mergeSettings({ review: { durationSec: 3 } }).review.durationSec).toBe(4);
    expect(mergeSettings({ review: { durationSec: 31 } }).review.durationSec).toBe(30);
  });

  it('非法类型回退到默认值', () => {
    const settings = mergeSettings({
      provider: { mode: 'bogus', ai: { baseUrl: 7, apiKey: 42, model: '' } },
      review: {
        enabled: 'yes',
        intervalSec: 'fast',
        displayMode: 5,
        position: 'left',
        durationSec: null,
        pausedHosts: 'a.com',
      },
    });
    expect(settings).toEqual(DEFAULT_SETTINGS);
  });
});

describe('getPublicSettings', () => {
  it('不泄露 API Key 与 AI 配置', async () => {
    store[STORAGE_KEYS.settings] = {
      provider: {
        mode: 'free',
        ai: { baseUrl: 'https://x/v1', apiKey: 'sk-secret', model: 'm' },
      },
    };
    const publicSettings = await getPublicSettings();
    const json = JSON.stringify(publicSettings);
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('sk-secret');
    expect(json).not.toContain('"ai"');
    expect(Object.prototype.hasOwnProperty.call(publicSettings.provider, 'ai')).toBe(false);
    expect(JSON.parse(json)).toEqual({
      provider: { mode: 'free' },
      review: DEFAULT_SETTINGS.review,
    });
  });

  it('AI 模式下也不泄露密钥字段', async () => {
    store[STORAGE_KEYS.settings] = {
      provider: { mode: 'ai', ai: { baseUrl: 'https://x/v1', apiKey: 'sk-secret', model: 'm' } },
    };
    const json = JSON.stringify(await getPublicSettings());
    expect(json).not.toContain('apiKey');
    expect(json).not.toContain('sk-secret');
  });
});

describe('ensureSchema', () => {
  it('写入 schema 版本', async () => {
    await ensureSchema();
    expect(store[STORAGE_KEYS.schema]).toBe(SCHEMA_VERSION);
  });
});

describe('importEntries replace', () => {
  it('替换旧集合、统计导入与跳过数量', async () => {
    store[STORAGE_KEYS.entries] = { old: sampleEntry({ id: 'old', text: 'old' }) };
    const result = await importEntries(
      [
        sampleEntry({ id: 'a', text: 'alpha' }),
        sampleEntry({ id: 'b', text: 'beta' }),
        { id: 'bad' },
        null,
      ],
      'replace',
    );
    expect(result).toEqual({ imported: 2, skipped: 2 });
    expect(Object.keys(await getEntriesMap()).sort()).toEqual(['a', 'b']);
  });
});

describe('upsertLookup', () => {
  it('不会延后未来的到期时间且不重复', async () => {
    const first = await upsertLookup(
      { id: 'e1', text: 'hello', kind: 'word', payload: { translation: '你好' } },
      NOW,
    );
    expect(first.entry.srs.dueAt).toBeGreaterThan(NOW);

    const later = NOW + 120_000;
    const result = await upsertLookup(
      { id: 'e2', text: 'HELLO', kind: 'word', payload: { translation: '喂' } },
      later,
    );
    expect(result.created).toBe(false);
    expect(result.entry.lookups).toBe(2);
    expect(result.entry.srs.dueAt).toBe(later);
    expect(Object.keys(await getEntriesMap())).toHaveLength(1);
  });
});

describe('listEntries', () => {
  function seed() {
    store[STORAGE_KEYS.entries] = {
      a: dueEntry('a', NOW - 1000, {
        text: 'Apple',
        translation: '苹果',
        note: 'Fruit',
        createdAt: NOW - 3000,
        lookups: 3,
      }),
      b: dueEntry('b', NOW + 1000, {
        text: 'banana',
        translation: '香蕉',
        createdAt: NOW - 2000,
        lookups: 1,
      }),
      c: dueEntry('c', NOW - 500, {
        text: 'I like apples',
        translation: '我喜欢苹果',
        kind: 'sentence',
        createdAt: NOW - 1000,
        lookups: 2,
      }),
    };
  }

  it('query 大小写不敏感地匹配 text/translation/note', async () => {
    seed();
    expect((await listEntries({ query: 'APPLE' }, NOW)).map((e) => e.id).sort()).toEqual([
      'a',
      'c',
    ]);
    expect((await listEntries({ query: '  fruit ' }, NOW)).map((e) => e.id)).toEqual(['a']);
    expect((await listEntries({ query: '苹果' }, NOW)).map((e) => e.id).sort()).toEqual([
      'a',
      'c',
    ]);
  });

  it('按 kind 与 dueOnly 过滤', async () => {
    seed();
    expect((await listEntries({ kind: 'sentence' }, NOW)).map((e) => e.id)).toEqual(['c']);
    expect((await listEntries({ dueOnly: true }, NOW)).map((e) => e.id).sort()).toEqual([
      'a',
      'c',
    ]);
  });

  it('按 due/lookups/created 排序', async () => {
    seed();
    expect((await listEntries({ sort: 'due' }, NOW)).map((e) => e.id)).toEqual(['a', 'c', 'b']);
    expect((await listEntries({ sort: 'lookups' }, NOW)).map((e) => e.id)).toEqual(['a', 'c', 'b']);
    expect((await listEntries({}, NOW)).map((e) => e.id)).toEqual(['c', 'b', 'a']);
  });
});

describe('deleteEntry / clearEntries', () => {
  it('删除返回布尔值并清空集合', async () => {
    store[STORAGE_KEYS.entries] = { e1: sampleEntry() };
    expect(await deleteEntry('e1')).toBe(true);
    expect(await deleteEntry('e1')).toBe(false);

    await saveEntry(sampleEntry({ id: 'e2', text: 'two' }));
    expect(Object.keys(await getEntriesMap())).toEqual(['e2']);

    await clearEntries();
    expect(await getEntriesMap()).toEqual({});
  });
});

describe('write serialization', () => {
  it('并发写入不丢失统计与词条', async () => {
    await Promise.all([
      bumpStat('shown', NOW),
      bumpStat('shown', NOW),
      bumpStat('shown', NOW),
      bumpStat('shown', NOW),
      bumpStat('shown', NOW),
      upsertLookup({ id: 'c1', text: 'one', kind: 'word', payload: { translation: '一' } }, NOW),
      upsertLookup({ id: 'c2', text: 'two', kind: 'word', payload: { translation: '二' } }, NOW),
    ]);

    expect((await getStats(NOW)).shown).toBe(5);
    expect(Object.keys(await getEntriesMap()).sort()).toEqual(['c1', 'c2']);
  });
});

describe('corrupt storage', () => {
  it('丢弃非法词条且不抛错', async () => {
    store[STORAGE_KEYS.entries] = { bad: null, broken: { id: 'x' }, ok: sampleEntry({ id: 'ok' }) };
    expect(Object.keys(await getEntriesMap())).toEqual(['ok']);
    expect((await listEntries({}, NOW)).map((e) => e.id)).toEqual(['ok']);
    expect(await listEntries({ dueOnly: true }, NOW)).toEqual([]);

    const result = await upsertLookup(
      { id: 'new', text: 'new', kind: 'word', payload: { translation: '新' } },
      NOW,
    );
    expect(result.created).toBe(true);
    expect(Object.keys(await getEntriesMap()).sort()).toEqual(['new', 'ok']);
  });

  it('非对象词条映射按空集合处理', async () => {
    store[STORAGE_KEYS.entries] = 'not-an-object';
    expect(await getEntriesMap()).toEqual({});
    expect(await listEntries({}, NOW)).toEqual([]);
    expect(
      (await upsertLookup(
        { id: 'e1', text: 'hello', kind: 'word', payload: { translation: '你好' } },
        NOW,
      )).created,
    ).toBe(true);

    store[STORAGE_KEYS.entries] = [];
    expect(await getEntriesMap()).toEqual({});
  });

  it('非数值统计归零', async () => {
    store[STORAGE_KEYS.stats] = {
      date: localDateKey(NOW),
      shown: 'x',
      reviewed: NaN,
      added: Infinity,
    };
    expect(await getStats(NOW)).toEqual({
      date: localDateKey(NOW),
      shown: 0,
      reviewed: 0,
      added: 0,
    });
  });

  it('非对象缓存按空缓存处理', async () => {
    store[STORAGE_KEYS.cache] = 'garbage';
    expect(await getCached('free:hello', NOW)).toBeNull();
    await setCached('free:hello', { translation: '你好' }, NOW);
    expect(await getCached('free:hello', NOW)).toEqual({ translation: '你好' });
    expect(trimCache('garbage' as never, 3)).toEqual({});
  });
});
