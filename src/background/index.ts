import { handleMessage } from './messages';
import { ensureSchema } from './storage';
import { isExtMessage } from '../shared/messages';
import type { Result, ReviewMode } from '../shared/types';

void ensureSchema();

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
  if (!tab?.id) {
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

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isExtMessage(message)) return false;

  if (message.type === 'review:preview') {
    previewActiveTab(message.payload.mode).then(sendResponse);
    return true;
  }

  handleMessage(message).then(sendResponse);
  return true;
});
