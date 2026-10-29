import { afterEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_TIMEOUT_MS } from '../src/shared/constants';
import { fetchJson, ProviderError } from '../src/shared/http';

const URL_UNDER_TEST = 'https://example.test/api';

function stubJsonResponse(status: number, body: unknown) {
  const fetchMock = vi.fn(async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function captureProviderError(promise: Promise<unknown>): Promise<ProviderError> {
  const error = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(ProviderError);
  return error as ProviderError;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('fetchJson', () => {
  it('429 抛出 RATE_LIMIT', async () => {
    stubJsonResponse(429, {});

    const error = await captureProviderError(fetchJson(URL_UNDER_TEST));

    expect(error.code).toBe('RATE_LIMIT');
  });

  it('500 抛出 NETWORK', async () => {
    stubJsonResponse(500, {});

    const error = await captureProviderError(fetchJson(URL_UNDER_TEST));

    expect(error.code).toBe('NETWORK');
  });

  it('fetch 抛 TypeError 时抛出 NETWORK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );

    const error = await captureProviderError(fetchJson(URL_UNDER_TEST));

    expect(error.code).toBe('NETWORK');
  });

  it('超时中止请求并抛出 NETWORK', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise<unknown>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              const abortError = new Error('This operation was aborted');
              abortError.name = 'AbortError';
              reject(abortError);
            });
          }),
      ),
    );

    const promise = fetchJson(URL_UNDER_TEST);
    const rejection = expect(promise).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'NETWORK',
      message: '请求超时',
    });
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await rejection;
  });

  it('成功时返回解析后的 JSON', async () => {
    const fetchMock = stubJsonResponse(200, { ok: true });

    await expect(fetchJson(URL_UNDER_TEST)).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('JSON 解析失败时抛出 NETWORK', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      })),
    );

    const error = await captureProviderError(fetchJson(URL_UNDER_TEST));

    expect(error.code).toBe('NETWORK');
  });
});
