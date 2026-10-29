import { REQUEST_TIMEOUT_MS } from './constants';
import type { ErrorCode } from './types';

export class ProviderError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (response.status === 429) {
      throw new ProviderError('RATE_LIMIT', '接口限流，请稍后再试');
    }
    if (!response.ok) {
      throw new ProviderError('NETWORK', `请求失败（${response.status}）`);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    if ((error as Error).name === 'AbortError') {
      throw new ProviderError('NETWORK', '请求超时');
    }
    throw new ProviderError('NETWORK', '网络异常');
  } finally {
    clearTimeout(timer);
  }
}
