import { createRoot } from 'react-dom/client';
import css from '../shared/styles/content.css?inline';
import type { ReviewMode } from '../shared/types';
import { createShadowHost } from './shadowHost';
import { ReviewHost } from './review/ReviewHost';
import { emitPreview } from './review/preview';
import { SelectionLayer } from './selection/SelectionLayer';
import { uiState } from './uiState';

const SELECTION_HOST_ID = 'ww-selection-host';
const REVIEW_HOST_ID = 'ww-review-host';
const CLEANUP_KEY = '__wwContentCleanup';

type ContentWindow = Window & { [CLEANUP_KEY]?: () => void };

function isReviewMode(value: unknown): value is ReviewMode {
  return value === 'subtitle' || value === 'barrage' || value === 'card';
}

/**
 * Content scripts can be injected more than once (reload during development,
 * manual `chrome.scripting.executeScript`). Tear the previous instance down so
 * its document/window listeners are removed before mounting a fresh one.
 */
function teardown(): void {
  const target = window as ContentWindow;
  target[CLEANUP_KEY]?.();
  target[CLEANUP_KEY] = undefined;
  document.getElementById(SELECTION_HOST_ID)?.remove();
  document.getElementById(REVIEW_HOST_ID)?.remove();
}

function mount(): void {
  const selectionHost = createShadowHost(SELECTION_HOST_ID, css, 2147483647);
  const reviewHost = createShadowHost(REVIEW_HOST_ID, css, 2147483646);
  const selectionRoot = createRoot(selectionHost.root);
  const reviewRoot = createRoot(reviewHost.root);
  selectionRoot.render(<SelectionLayer />);
  reviewRoot.render(<ReviewHost />);
  (window as ContentWindow)[CLEANUP_KEY] = () => {
    selectionRoot.unmount();
    reviewRoot.unmount();
    // Do not leave stale "UI open" flags behind for the next injection.
    uiState.cardOpen = false;
    uiState.overlayOpen = false;
    document.getElementById(SELECTION_HOST_ID)?.remove();
    document.getElementById(REVIEW_HOST_ID)?.remove();
  };
}

teardown();
mount();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message === null || typeof message !== 'object') return false;
  const candidate = message as { type?: unknown; payload?: { mode?: unknown } };
  if (candidate.type !== 'content:preview') return false;
  if (!isReviewMode(candidate.payload?.mode)) {
    sendResponse({ shown: false });
    return false;
  }
  emitPreview(candidate.payload.mode);
  sendResponse({ shown: true });
  return false;
});
