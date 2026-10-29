import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome';
import type { MessageListener } from './helpers/chrome';
import { handleMessage } from '../src/background/messages';
import { isExtMessage } from '../src/shared/messages';
import { getEntriesMap, getSettings, getStats, updateSettings } from '../src/background/storage';
import { STORAGE_KEYS } from '../src/shared/constants';
import type {
  Entry,
  ExportBundle,
  ExtMessage,
  Settings,
  Stats,
} from '../src/shared/types';

const NOW = 1_700_000_000_000;
const EXTENSION_ORIGIN = 'chrome-extension://test-extension-id';

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

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    text: 'hello',
    kind: 'word',
    translation: '你好',
    createdAt: NOW - 1000,
    updatedAt: NOW - 1000,
    lookups: 1,
    srs: { stage: 1, dueAt: NOW - 1, reps: 1, lapses: 0, knownStreak: 1 },
    ...overrides,
  };
}

let mock: ReturnType<typeof installChromeMock>;
let store: Record<string, unknown>;

beforeEach(() => {
  mock = installChromeMock();
  store = mock.store;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function loadBackground(): Promise<{
  mod: typeof import('../src/background/index');
  listener: MessageListener;
}> {
  vi.resetModules();
  const mod = await import('../src/background/index');
  const listeners = mock.runtime.onMessage.listeners;
  return { mod, listener: listeners[listeners.length - 1] };
}

function dispatch(
  listener: MessageListener,
  message: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<unknown> {
  return new Promise((resolve) => {
    listener(message, sender, (response) => resolve(response));
  });
}

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

  it('重复查询不重复累加 added', async () => {
    const first = await handleMessage({ type: 'lookup', payload: { text: 'hello' } }, NOW);
    expect(first.ok).toBe(true);
    const second = await handleMessage({ type: 'lookup', payload: { text: 'hello' } }, NOW + 1);
    expect(second.ok).toBe(true);
    expect((await getStats(NOW)).added).toBe(1);
    const entries = Object.values(await getEntriesMap());
    expect(entries).toHaveLength(1);
    expect(entries[0].lookups).toBe(2);
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

  it('站点暂停时不增加 shown', async () => {
    await updateSettings({ review: { pausedHosts: ['example.com'] } });
    const result = await handleMessage(
      { type: 'review:next', payload: { host: 'example.com', recentIds: [] } },
      NOW,
    );
    expect((result as { data: Entry | null }).data).toBeNull();
    expect((await getStats(NOW)).shown).toBe(0);
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

  it('settings:public 不泄露已配置的密钥明文', async () => {
    store[STORAGE_KEYS.settings] = { provider: { mode: 'ai', ai: { apiKey: 'sk-secret' } } };
    const result = await handleMessage({ type: 'settings:public', payload: {} }, NOW);
    expect(result.ok).toBe(true);
    const serialized = JSON.stringify((result as { data: Record<string, unknown> }).data);
    expect(serialized).not.toContain('sk-secret');
    expect(serialized).not.toContain('apiKey');
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

  it('words:update 写入备注并保留空白译义', async () => {
    store[STORAGE_KEYS.entries] = { e1: makeEntry() };
    const result = await handleMessage(
      { type: 'words:update', payload: { id: 'e1', patch: { note: '重点词', translation: '   ' } } },
      NOW,
    );
    expect(result.ok).toBe(true);
    const data = (result as { data: Entry }).data;
    expect(data.note).toBe('重点词');
    expect(data.translation).toBe('你好');
    expect((await getEntriesMap()).e1.note).toBe('重点词');
  });

  it('words:clear 清空生词本', async () => {
    store[STORAGE_KEYS.entries] = { e1: makeEntry() };
    const result = await handleMessage({ type: 'words:clear', payload: {} }, NOW);
    expect(result.ok).toBe(true);
    expect(await getEntriesMap()).toEqual({});
  });

  it('words:export 导出词条与脱敏设置', async () => {
    store[STORAGE_KEYS.entries] = { e1: makeEntry() };
    store[STORAGE_KEYS.settings] = { provider: { mode: 'ai', ai: { apiKey: 'sk-secret' } } };
    const result = await handleMessage({ type: 'words:export', payload: {} }, NOW);
    expect(result.ok).toBe(true);
    const data = (result as { data: ExportBundle }).data;
    expect(data.entries.map((entry) => entry.id)).toEqual(['e1']);
    expect(data.settings.provider.ai.apiKey).toBe('');
    expect(JSON.stringify(data)).not.toContain('sk-secret');
  });

  it('stats:get 返回当日统计', async () => {
    const result = await handleMessage({ type: 'stats:get', payload: {} }, NOW);
    expect(result.ok).toBe(true);
    expect((result as { data: Stats }).data).toMatchObject({ shown: 0, reviewed: 0, added: 0 });
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

describe('provider:test', () => {
  it('免费模式返回样例', async () => {
    mockFetch();
    const result = await handleMessage({ type: 'provider:test', payload: {} }, NOW);
    expect(result).toEqual({ ok: true, data: { provider: 'free', sample: '你好' } });
  });

  it('网络失败时返回错误信封', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('boom');
      }),
    );
    const result = await handleMessage({ type: 'provider:test', payload: {} }, NOW);
    expect(result).toMatchObject({ ok: false, error: { code: 'NETWORK' } });
  });
});

describe('消息与载荷校验', () => {
  it('isExtMessage 接受合法消息并拒绝其他输入', () => {
    expect(isExtMessage({ type: 'lookup', payload: { text: 'hi' } })).toBe(true);
    for (const value of [null, [], 'lookup', {}, { type: 'nope' }]) {
      expect(isExtMessage(value)).toBe(false);
    }
  });

  it('拒绝缺失载荷', async () => {
    const result = await handleMessage({ type: 'lookup' } as unknown as ExtMessage, NOW);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  });

  it('lookup 缺少文本时返回 INVALID_PAYLOAD', async () => {
    const result = await handleMessage(
      { type: 'lookup', payload: {} } as unknown as ExtMessage,
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  });

  it('review:next 的 host 非字符串时返回 INVALID_PAYLOAD', async () => {
    const result = await handleMessage(
      { type: 'review:next', payload: { host: 42, recentIds: [] } } as unknown as ExtMessage,
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  });

  it('review:next 缺少 host 时按空站点参与暂停检查', async () => {
    store[STORAGE_KEYS.entries] = { e1: makeEntry() };
    await updateSettings({ review: { pausedHosts: [''] } });
    const result = await handleMessage(
      { type: 'review:next', payload: { recentIds: [] } } as unknown as ExtMessage,
      NOW,
    );
    expect((result as { data: Entry | null }).data).toBeNull();
  });

  it('review:rate 缺少 id 或 rating 时返回 INVALID_PAYLOAD', async () => {
    store[STORAGE_KEYS.entries] = { e1: makeEntry() };
    const missingId = await handleMessage(
      { type: 'review:rate', payload: { rating: 'known' } } as unknown as ExtMessage,
      NOW,
    );
    expect(missingId).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    const missingRating = await handleMessage(
      { type: 'review:rate', payload: { id: 'e1' } } as unknown as ExtMessage,
      NOW,
    );
    expect(missingRating).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  });

  it('非法评分返回 INVALID_PAYLOAD', async () => {
    store[STORAGE_KEYS.entries] = { e1: makeEntry() };
    const result = await handleMessage(
      { type: 'review:rate', payload: { id: 'e1', rating: 'maybe' } } as unknown as ExtMessage,
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  });

  it('words:update 与 words:delete 缺少 id 时返回 INVALID_PAYLOAD', async () => {
    const update = await handleMessage(
      { type: 'words:update', payload: { patch: { note: 'x' } } } as unknown as ExtMessage,
      NOW,
    );
    expect(update).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
    const remove = await handleMessage(
      { type: 'words:delete', payload: {} } as unknown as ExtMessage,
      NOW,
    );
    expect(remove).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  });

  it('words:import 的 mode 非法时返回 INVALID_PAYLOAD', async () => {
    const result = await handleMessage(
      { type: 'words:import', payload: { entries: [], mode: 'upsert' } } as unknown as ExtMessage,
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_PAYLOAD' } });
  });
});

describe('isExtensionPage 与发送方鉴权', () => {
  it('仅将扩展页面识别为扩展页', async () => {
    const { mod } = await loadBackground();
    expect(mod.isExtensionPage({ url: `${EXTENSION_ORIGIN}/popup.html` })).toBe(true);
    expect(mod.isExtensionPage({ origin: EXTENSION_ORIGIN })).toBe(true);
    expect(mod.isExtensionPage({ url: 'https://example.com/' })).toBe(false);
    expect(mod.isExtensionPage({})).toBe(false);
  });

  it('注册 onInstalled 与 onStartup 初始化钩子', async () => {
    await loadBackground();
    expect(mock.runtime.onInstalled.listeners).toHaveLength(1);
    expect(mock.runtime.onStartup.listeners).toHaveLength(1);
    mock.runtime.onInstalled.listeners[0]();
    mock.runtime.onStartup.listeners[0]();
  });

  it('拒绝内容脚本读取设置且不泄露密钥', async () => {
    store[STORAGE_KEYS.settings] = { provider: { mode: 'ai', ai: { apiKey: 'sk-secret' } } };
    const { listener } = await loadBackground();
    const response = await dispatch(listener, { type: 'settings:get', payload: {} }, {
      url: 'https://example.com/',
      tab: { id: 3 } as chrome.tabs.Tab,
    });
    expect(response).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    expect(JSON.stringify(response)).not.toContain('sk-secret');
  });

  it('扩展页面可以读取设置', async () => {
    store[STORAGE_KEYS.settings] = { provider: { mode: 'ai', ai: { apiKey: 'sk-secret' } } };
    const { listener } = await loadBackground();
    const response = await dispatch(listener, { type: 'settings:get', payload: {} }, {
      url: `${EXTENSION_ORIGIN}/options.html`,
    });
    expect(response).toMatchObject({ ok: true });
    expect(JSON.stringify(response)).toContain('sk-secret');
  });

  it('内容脚本仍可发起查询', async () => {
    mockFetch();
    const { listener } = await loadBackground();
    const response = await dispatch(listener, { type: 'lookup', payload: { text: 'hello' } }, {
      url: 'https://example.com/a',
      tab: { id: 3 } as chrome.tabs.Tab,
    });
    expect(response).toMatchObject({ ok: true });
    expect(Object.values(await getEntriesMap())).toHaveLength(1);
  });

  it('内容脚本可以读取公开设置且响应不含 apiKey', async () => {
    store[STORAGE_KEYS.settings] = { provider: { mode: 'ai', ai: { apiKey: 'sk-secret' } } };
    const { listener } = await loadBackground();
    const response = await dispatch(listener, { type: 'settings:public', payload: {} }, {
      url: 'https://example.com/a',
      tab: { id: 3 } as chrome.tabs.Tab,
    });
    expect(response).toMatchObject({ ok: true });
    const serialized = JSON.stringify(response);
    expect(serialized).not.toContain('apiKey');
    expect(serialized).not.toContain('sk-secret');
    expect((response as { data: { review: { enabled: boolean } } }).data.review).toBeDefined();
  });

  it('内容脚本可以删除已有词条', async () => {
    store[STORAGE_KEYS.entries] = { e1: makeEntry() };
    const { listener } = await loadBackground();
    const response = await dispatch(listener, { type: 'words:delete', payload: { id: 'e1' } }, {
      url: 'https://example.com/a',
      tab: { id: 3 } as chrome.tabs.Tab,
    });
    expect(response).toMatchObject({ ok: true, data: { deleted: true } });
    expect(await getEntriesMap()).toEqual({});
  });

  it('内容脚本仍被拒绝其他特权消息', async () => {
    store[STORAGE_KEYS.entries] = { e1: makeEntry() };
    const { listener } = await loadBackground();
    const sender = { url: 'https://example.com/a', tab: { id: 3 } as chrome.tabs.Tab };
    const forbidden: ExtMessage[] = [
      { type: 'settings:get', payload: {} },
      { type: 'settings:update', payload: {} },
      { type: 'provider:test', payload: {} },
      { type: 'words:import', payload: { entries: [], mode: 'merge' } },
      { type: 'words:clear', payload: {} },
      { type: 'words:export', payload: {} },
    ];
    for (const message of forbidden) {
      const response = await dispatch(listener, message, sender);
      expect(response).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    expect(await getEntriesMap()).toHaveProperty('e1');
  });
});

describe('previewActiveTab', () => {
  it('向活动标签页发送预览消息', async () => {
    mock.tabs.query.mockResolvedValueOnce([{ id: 5 } as chrome.tabs.Tab]);
    mock.tabs.sendMessage.mockResolvedValueOnce({ shown: true });
    const { mod } = await loadBackground();
    const result = await mod.previewActiveTab('subtitle');
    expect(result).toEqual({ ok: true, data: { shown: true } });
    expect(mock.tabs.sendMessage).toHaveBeenCalledWith(5, {
      type: 'content:preview',
      payload: { mode: 'subtitle' },
    });
  });

  it('没有活动标签页时返回 NOT_FOUND', async () => {
    mock.tabs.query.mockResolvedValueOnce([]);
    const { mod } = await loadBackground();
    const result = await mod.previewActiveTab('card');
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });

  it('发送失败时返回 NOT_FOUND 而不抛出', async () => {
    mock.tabs.query.mockResolvedValueOnce([{ id: 7 } as chrome.tabs.Tab]);
    mock.tabs.sendMessage.mockRejectedValueOnce(new Error('no receiver'));
    const { mod } = await loadBackground();
    await expect(mod.previewActiveTab('barrage')).resolves.toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
  });
});
