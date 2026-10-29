import { handleMessage } from './messages';
import { ensureSchema } from './storage';
import { isExtMessage } from '../shared/messages';
import type { Result, ReviewMode } from '../shared/types';

/** Message types a content script is allowed to send. Everything else is extension-page only. */
const CONTENT_SCRIPT_ALLOWED = new Set<string>([
  'lookup',
  'review:next',
  'review:rate',
  'settings:public',
  'words:delete',
]);

function ensureSchemaSafe(): void {
  void ensureSchema().catch(() => undefined);
}

ensureSchemaSafe();

chrome.runtime.onInstalled.addListener(ensureSchemaSafe);
chrome.runtime.onStartup.addListener(ensureSchemaSafe);

function extensionOrigin(): string {
  const url = chrome.runtime.getURL('');
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * True only for pages served from the extension origin (popup, options, manager...).
 * Content scripts report the host page URL/origin, so they are never extension pages.
 * Do not gate on `sender.tab`: extension pages open in regular tabs too.
 */
export function isExtensionPage(sender: chrome.runtime.MessageSender): boolean {
  const origin = extensionOrigin();
  const prefix = `${origin}/`;
  return [sender.url, sender.origin].some(
    (value) => typeof value === 'string' && (value === origin || value.startsWith(prefix)),
  );
}

async function queryActiveTab(): Promise<chrome.tabs.Tab | null> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab ?? null;
  } catch {
    return null;
  }
}

export async function previewActiveTab(mode: ReviewMode): Promise<Result<{ shown: boolean }>> {
  const tab = await queryActiveTab();
  if (tab?.id == null) {
    return { ok: false, error: { code: 'NOT_FOUND', message: '没有可用的活动网页' } };
  }
  try {
    const response = await chrome.tabs.sendMessage(tab.id, {
      type: 'content:preview',
      payload: { mode },
    });
    return { ok: true, data: { shown: Boolean(response?.shown) } };
  } catch {
    return { ok: false, error: { code: 'NOT_FOUND', message: '当前页面不支持预览' } };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isExtMessage(message)) return false;

  if (!isExtensionPage(sender) && !CONTENT_SCRIPT_ALLOWED.has(message.type)) {
    sendResponse({ ok: false, error: { code: 'FORBIDDEN', message: '无权访问' } });
    return false;
  }

  if (message.type === 'review:preview') {
    const mode = (message.payload as { mode?: unknown } | undefined)?.mode;
    const task: Promise<Result<unknown>> =
      mode === 'subtitle' || mode === 'barrage' || mode === 'card'
        ? previewActiveTab(mode)
        : Promise.resolve({
            ok: false,
            error: { code: 'INVALID_PAYLOAD', message: '预览模式无效' },
          });
    task.then(sendResponse).catch(() => undefined);
    return true;
  }

  handleMessage(message).then(sendResponse).catch(() => undefined);
  return true;
});
