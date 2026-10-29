import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome';
import { handleMessage } from '../src/background/messages';
import { getEntriesMap, getSettings, getStats, updateSettings } from '../src/background/storage';
import { STORAGE_KEYS } from '../src/shared/constants';
import type { Entry, Settings } from '../src/shared/types';

const NOW = 1_700_000_000_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dictionaryapi')) {
        return json([
          {
            word: 'hello',
            phonetic: '/həˈləʊ/',
            meanings: [
              {
                partOfSpeech: 'exclamation',
                definitions: [{ definition: 'used as a greeting', example: 'hello there' }],
              },
            ],
          },
        ]);
      }
      return json([[['你好', 'hello']]]);
    }),
  );
}

let store: Record<string, unknown>;

beforeEach(() => {
  store = installChromeMock().store;
});

describe('lookup', () => {
  beforeEach(() => {
    mockFetch();
  });

  it('拒绝空文本', async () => {
    const result = await handleMessage({ type: 'lookup', payload: { text: '   ' } }, NOW);
    expect(result.ok).toBe(false);
  });

  it('查询成功后写入生词本并统计 added', async () => {
    const result = await handleMessage(
      {
        type: 'lookup',
        payload: { text: 'hello', context: 'say hello', sourceUrl: 'https://example.com/a' },
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    const entries = Object.values(await getEntriesMap());
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('hello');
    expect(entries[0].sourceUrl).toBe('https://example.com/a');
    expect((await getStats(NOW)).added).toBe(1);
  });
});

describe('review', () => {
  beforeEach(() => {
    store[STORAGE_KEYS.entries] = {
      e1: {
        id: 'e1',
        text: 'hello',
        kind: 'word',
        translation: '你好',
        createdAt: NOW - 1000,
        updatedAt: NOW - 1000,
        lookups: 1,
        srs: {
          stage: 1,
          dueAt: NOW - 1,
          reps: 1,
          lapses: 0,
          knownStreak: 1,
        },
      } satisfies Entry,
    };
  });

  it('返回到期词条并增加 shown', async () => {
    const result = await handleMessage(
      { type: 'review:next', payload: { host: 'example.com', recentIds: [] } },
      NOW,
    );
    expect(result.ok).toBe(true);
    const data = (result as { data: Entry | null }).data;
    expect(data?.id).toBe('e1');
    expect((await getStats(NOW)).shown).toBe(1);
  });

  it('站点暂停时不返回词条', async () => {
    await updateSettings({ review: { pausedHosts: ['example.com'] } });
    const result = await handleMessage(
      { type: 'review:next', payload: { host: 'example.com', recentIds: [] } },
      NOW,
    );
    expect((result as { data: Entry | null }).data).toBeNull();
  });

  it('评分推进 SRS 并增加 reviewed', async () => {
    const result = await handleMessage(
      { type: 'review:rate', payload: { id: 'e1', rating: 'known' } },
      NOW,
    );
    expect(result.ok).toBe(true);
    const data = (result as { data: { entry: Entry } }).data;
    expect(data.entry.srs.stage).toBe(2);
    const entries = await getEntriesMap();
    expect(entries.e1.srs.stage).toBe(2);
    expect((await getStats(NOW)).reviewed).toBe(1);
  });

  it('评分不存在的词条返回 NOT_FOUND', async () => {
    const result = await handleMessage(
      { type: 'review:rate', payload: { id: 'nope', rating: 'known' } },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('words 与 settings', () => {
  it('更新设置时深合并并保留其余字段', async () => {
    const first = await handleMessage(
      { type: 'settings:update', payload: { provider: { mode: 'ai' } } },
      NOW,
    );
    expect(first.ok).toBe(true);
    const second = await handleMessage(
      { type: 'settings:update', payload: { review: { intervalSec: 60 } } },
      NOW,
    );
    expect(second.ok).toBe(true);
    const settings = (second as { data: Settings }).data;
    expect(settings.provider.mode).toBe('ai');
    expect(settings.review.intervalSec).toBe(60);
    expect((await getSettings()).provider.mode).toBe('ai');
  });

  it('settings:public 不包含 API Key', async () => {
    const result = await handleMessage({ type: 'settings:public', payload: {} }, NOW);
    const data = (result as { data: Record<string, unknown> }).data;
    expect(JSON.stringify(data)).not.toContain('apiKey');
  });

  it('删除词条', async () => {
    store[STORAGE_KEYS.entries] = {
      e1: {
        id: 'e1',
        text: 'x',
        kind: 'word',
        translation: 'x',
        createdAt: NOW,
        updatedAt: NOW,
        lookups: 1,
        srs: { stage: 0, dueAt: NOW, reps: 0, lapses: 0, knownStreak: 0 },
      },
    };
    const result = await handleMessage({ type: 'words:delete', payload: { id: 'e1' } }, NOW);
    expect(result.ok).toBe(true);
    expect(await getEntriesMap()).toEqual({});
  });

  it('words:list 支持搜索与排序', async () => {
    store[STORAGE_KEYS.entries] = {
      a: {
        id: 'a',
        text: 'apple',
        kind: 'word',
        translation: '苹果',
        createdAt: NOW,
        updatedAt: NOW,
        lookups: 3,
        srs: { stage: 0, dueAt: NOW, reps: 0, lapses: 0, knownStreak: 0 },
      },
      b: {
        id: 'b',
        text: 'banana',
        kind: 'word',
        translation: '香蕉',
        createdAt: NOW + 1,
        updatedAt: NOW + 1,
        lookups: 1,
        srs: { stage: 0, dueAt: NOW, reps: 0, lapses: 0, knownStreak: 0 },
      },
    };
    const result = await handleMessage(
      { type: 'words:list', payload: { query: 'apple', sort: 'lookups' } },
      NOW,
    );
    const data = (result as { data: Entry[] }).data;
    expect(data.map((entry) => entry.id)).toEqual(['a']);
  });
});
