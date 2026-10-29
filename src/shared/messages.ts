import { delay } from './utils';
import type { ExtMessage, Result } from './types';

const MESSAGE_TYPES = new Set<string>([
  'lookup',
  'review:next',
  'review:rate',
  'words:list',
  'words:update',
  'words:delete',
  'words:clear',
  'words:import',
  'words:export',
  'settings:get',
  'settings:public',
  'settings:update',
  'provider:test',
  'stats:get',
  'review:preview',
]);

export function isExtMessage(value: unknown): value is ExtMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    MESSAGE_TYPES.has(String((value as { type?: unknown }).type))
  );
}

export async function sendToBackground<T>(message: ExtMessage): Promise<Result<T>> {
  try {
    return (await chrome.runtime.sendMessage(message)) as Result<T>;
  } catch {
    await delay(300);
    return (await chrome.runtime.sendMessage(message)) as Result<T>;
  }
}
