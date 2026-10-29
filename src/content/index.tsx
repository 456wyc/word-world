import { createRoot } from 'react-dom/client';
import css from '../shared/styles/content.css?inline';
import { createShadowHost } from './shadowHost';
import { SelectionLayer } from './selection/SelectionLayer';

const HOST_ID = 'ww-selection-host';
const CLEANUP_KEY = '__wwContentCleanup';

type ContentWindow = Window & { [CLEANUP_KEY]?: () => void };

/**
 * Content scripts can be injected more than once (reload during development,
 * manual `chrome.scripting.executeScript`). Tear the previous instance down so
 * its document/window listeners are removed before mounting a fresh one.
 */
function teardown(): void {
  const target = window as ContentWindow;
  target[CLEANUP_KEY]?.();
  target[CLEANUP_KEY] = undefined;
  document.getElementById(HOST_ID)?.remove();
}

function mount(): void {
  const { root } = createShadowHost(HOST_ID, css, 2147483647);
  const reactRoot = createRoot(root);
  reactRoot.render(<SelectionLayer />);
  (window as ContentWindow)[CLEANUP_KEY] = () => {
    reactRoot.unmount();
    document.getElementById(HOST_ID)?.remove();
  };
}

teardown();
mount();
