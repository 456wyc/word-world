export interface ShadowHost {
  host: HTMLDivElement;
  root: HTMLDivElement;
}

const ROOT_CLASS = 'ww-root';

function ensureRoot(host: HTMLDivElement): HTMLDivElement | null {
  const shadow = host.shadowRoot;
  if (!shadow) return null;
  const existing = shadow.querySelector<HTMLDivElement>(`.${ROOT_CLASS}`);
  if (existing) return existing;
  const root = document.createElement('div');
  root.className = ROOT_CLASS;
  shadow.appendChild(root);
  return root;
}

/**
 * Mounts a full-viewport, pointer-events-none host with a shadow root.
 * If the host id already exists (content script re-injected without a
 * teardown), the existing host and React root are reused so only one UI
 * instance can ever be mounted per id.
 */
export function createShadowHost(id: string, cssText: string, zIndex: number): ShadowHost {
  const existing = document.getElementById(id);
  if (existing instanceof HTMLDivElement) {
    const root = ensureRoot(existing);
    if (root) return { host: existing, root };
  }

  const host = document.createElement('div');
  host.id = id;
  host.dataset.wwUi = '1';
  host.style.cssText = `all: initial; position: fixed; inset: 0; z-index: ${zIndex}; pointer-events: none;`;

  const shadow = host.attachShadow({ mode: 'open' });
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(cssText);
    shadow.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = cssText;
    shadow.appendChild(style);
  }

  const root = document.createElement('div');
  root.className = ROOT_CLASS;
  shadow.appendChild(root);
  document.documentElement.appendChild(host);
  return { host, root };
}
