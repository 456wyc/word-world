import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome';
import { parseAiPayload, resolveLookup, aiLookup } from '../src/background/providers';
import { freeLookup, translateText } from '../src/background/providers/free';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import type { Settings } from '../src/shared/types';

const storageWrites = vi.hoisted(() => ({ fail: false, calls: 0 }));

vi.mock('../src/background/storage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/background/storage')>();
  return {
    ...actual,
    setCached: (...args: Parameters<typeof actual.setCached>) => {
      storageWrites.calls += 1;
      return storageWrites.fail
        ? Promise.reject(new Error('storage write failed'))
        : actual.setCached(...args);
    },
  };
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

const DICT = [
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
];

const GOOGLE = [[['你好', 'hello', null, null]]];

describe('free provider', () => {
  beforeEach(() => {
    installChromeMock();
  });

  it('单词返回音标、释义、例句与译义', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
      ),
    );
    const result = await freeLookup('hello', 'word');
    expect(result.translation).toBe('你好');
    expect(result.phonetic).toBe('/həˈləʊ/');
    expect(result.senses?.[0]).toEqual({ pos: 'exclamation', def: 'used as a greeting' });
    expect(result.example).toBe('hello there');
  });

  it('Google 失败时回退 MyMemory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('translate.googleapis')) return json({}, 500);
        if (url.includes('mymemory')) return json({ responseStatus: 200, responseData: { translatedText: '世界' } });
        return json(DICT);
      }),
    );
    await expect(translateText('world')).resolves.toBe('世界');
  });

  it('词典失败但翻译成功仍返回条目', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json({}, 404) : json(GOOGLE),
      ),
    );
    const result = await freeLookup('hello', 'word');
    expect(result.translation).toBe('你好');
    expect(result.senses).toBeUndefined();
  });

  it('词典返回空数组时仍返回译义', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json([]) : json(GOOGLE),
      ),
    );
    const result = await freeLookup('hello', 'word');
    expect(result).toEqual({ translation: '你好' });
  });

  it('句子翻译走 Google 主接口', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => json(GOOGLE));
    vi.stubGlobal('fetch', fetchMock);
    await expect(translateText('hello world')).resolves.toBe('你好');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('translate.googleapis.com');
    expect(url).toContain('tl=zh-CN');
  });

  it('429 时抛 RATE_LIMIT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 429)),
    );
    await expect(translateText('hello')).rejects.toMatchObject({ code: 'RATE_LIMIT' });
    await expect(freeLookup('hello', 'word')).rejects.toMatchObject({ code: 'RATE_LIMIT' });
  });

  it('词典与翻译都失败时抛 NETWORK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 500)),
    );
    await expect(freeLookup('hello', 'word')).rejects.toMatchObject({ code: 'NETWORK' });
  });
});

describe('ai provider', () => {
  beforeEach(() => {
    installChromeMock();
  });

  it('解析 fenced JSON', () => {
    const payload = parseAiPayload('```json\n{"translation":"你好","phonetic":"/h/","senses":[{"pos":"int.","def":"问候"}],"example":"hi"}\n```');
    expect(payload).toEqual({
      translation: '你好',
      phonetic: '/h/',
      senses: [{ pos: 'int.', def: '问候' }],
      example: 'hi',
    });
  });

  it('缺少 translation 时抛错', () => {
    expect(() => parseAiPayload('{"foo":1}')).toThrow();
  });

  it('拒绝非 JSON 内容', () => {
    expect(() => parseAiPayload('not json at all')).toThrow();
    expect(() => parseAiPayload('[]')).toThrow();
  });

  it('最多保留 4 条释义并忽略无 def 的条目', () => {
    const payload = parseAiPayload(
      JSON.stringify({
        translation: '你好',
        senses: [
          { pos: 'n.', def: '1' },
          { pos: 'n.', def: '2' },
          { def: '3' },
          { pos: 'n.', def: '4' },
          { pos: 'n.', def: '5' },
          { pos: 'n.' },
        ],
      }),
    );
    expect(payload.senses).toHaveLength(4);
    expect(payload.senses?.map((sense) => sense.def)).toEqual(['1', '2', '3', '4']);
  });

  it('未配置 Key 抛 CONFIG', async () => {
    await expect(
      aiLookup('hello', 'word', undefined, { baseUrl: 'https://x/v1', apiKey: '', model: 'm' }),
    ).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('调用 chat/completions 并解析结果', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      json({ choices: [{ message: { content: '{"translation":"你好"}' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const payload = await aiLookup('hello', 'word', 'say hello', {
      baseUrl: 'https://x/v1/',
      apiKey: 'k',
      model: 'm',
    });
    expect(payload.translation).toBe('你好');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://x/v1/chat/completions');
  });
});

describe('resolveLookup', () => {
  beforeEach(() => {
    installChromeMock();
  });

  const aiSettings: Settings = {
    ...DEFAULT_SETTINGS,
    provider: { mode: 'ai', ai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } },
  };

  it('AI 失败回退 free 且标记 fallbackReason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
      ),
    );
    const result = await resolveLookup('hello', undefined, aiSettings);
    expect(result.provider).toBe('free');
    expect(result.fallbackReason).toBe('ai-error');
  });

  it('AI 成功时 provider 为 ai 且不标记 fallbackReason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({ choices: [{ message: { content: '{"translation":"你好","senses":[{"pos":"int.","def":"问候"}]}' } }] }),
      ),
    );
    const result = await resolveLookup('hello', undefined, aiSettings);
    expect(result.provider).toBe('ai');
    expect(result.fallbackReason).toBeNull();
    expect(result.cached).toBe(false);
    expect(result.payload.translation).toBe('你好');
  });

  it('AI 未配置 Key 直接走 free', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
      ),
    );
    const result = await resolveLookup('hello', undefined, DEFAULT_SETTINGS);
    expect(result.provider).toBe('free');
    expect(result.fallbackReason).toBeNull();
  });

  it('AI 模式未配置 Key 时回退 free 并标记 ai-unconfigured', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
    );
    vi.stubGlobal('fetch', fetchMock);
    const settings: Settings = {
      ...DEFAULT_SETTINGS,
      provider: { mode: 'ai', ai: { baseUrl: 'https://x/v1', apiKey: '', model: 'm' } },
    };
    const result = await resolveLookup('hello', undefined, settings);
    expect(result.provider).toBe('free');
    expect(result.fallbackReason).toBe('ai-unconfigured');
    expect(fetchMock.mock.calls.every((call) => !String(call[0]).includes('chat/completions'))).toBe(true);
  });

  it('第二次查询命中缓存', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
    );
    vi.stubGlobal('fetch', fetchMock);
    await resolveLookup('hello', undefined, DEFAULT_SETTINGS);
    const second = await resolveLookup('hello', undefined, DEFAULT_SETTINGS);
    expect(second.cached).toBe(true);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });

  it('缓存命中不发起请求且返回 cached 结果', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
    );
    vi.stubGlobal('fetch', fetchMock);
    const first = await resolveLookup('Hello', undefined, DEFAULT_SETTINGS);
    expect(first.cached).toBe(false);
    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await resolveLookup('  hello  ', undefined, DEFAULT_SETTINGS);
    expect(second.cached).toBe(true);
    expect(second.payload.translation).toBe('你好');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it('免费接口限流时抛出 RATE_LIMIT', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json({}, 429)),
    );
    await expect(resolveLookup('hello', undefined, DEFAULT_SETTINGS)).rejects.toMatchObject({
      code: 'RATE_LIMIT',
    });
  });

  it('AI 接口限流时回退 free 并标记 rate-limit', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('chat/completions')) return json({}, 429);
        return url.includes('dictionaryapi') ? json(DICT) : json(GOOGLE);
      }),
    );
    const result = await resolveLookup('hello', undefined, aiSettings);
    expect(result.provider).toBe('free');
    expect(result.fallbackReason).toBe('rate-limit');
    expect(result.payload.translation).toBe('你好');
    expect(result.payload.senses).toEqual([{ pos: 'exclamation', def: 'used as a greeting' }]);
  });

  it('缓存写入失败不影响查询结果', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
      ),
    );
    storageWrites.fail = true;
    const writesBefore = storageWrites.calls;
    try {
      const result = await resolveLookup('hello', undefined, DEFAULT_SETTINGS);
      expect(storageWrites.calls).toBe(writesBefore + 1);
      expect(result.provider).toBe('free');
      expect(result.cached).toBe(false);
      expect(result.payload.translation).toBe('你好');
      expect(result.payload.phonetic).toBe('/həˈləʊ/');
    } finally {
      storageWrites.fail = false;
    }
  });

  it('译文为空的 payload 不写入缓存，下次重新请求', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dictionaryapi')) return json(DICT);
      if (url.includes('mymemory')) {
        return json({ responseStatus: 200, responseData: { translatedText: '' } });
      }
      return json({}, 503);
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = await resolveLookup('hello', undefined, DEFAULT_SETTINGS);
    expect(first.cached).toBe(false);
    expect(first.payload.translation).toBe('');
    expect(first.payload.senses).toHaveLength(1);

    const callsAfterFirst = fetchMock.mock.calls.length;
    const second = await resolveLookup('hello', undefined, DEFAULT_SETTINGS);
    expect(second.cached).toBe(false);
    expect(second.payload.translation).toBe('');
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst * 2);
  });
});
