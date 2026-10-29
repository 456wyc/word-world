import { vi } from 'vitest';

type Store = Record<string, unknown>;

export type MessageListener = (
  message: unknown,
  sender: chrome.runtime.MessageSender,
  sendResponse: (response?: unknown) => void,
) => boolean | undefined;

type EventListener = (...args: unknown[]) => void;

export function installChromeMock(initial: Store = {}) {
  const store: Store = structuredClone(initial);
  const listeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  > = [];
  const messageListeners: MessageListener[] = [];
  const installedListeners: EventListener[] = [];
  const startupListeners: EventListener[] = [];

  const local = {
    get: vi.fn(async (keys?: string | string[] | null) => {
      if (keys == null) return { ...store };
      const list = Array.isArray(keys) ? keys : [keys];
      const result: Store = {};
      for (const key of list) if (key in store) result[key] = store[key];
      return result;
    }),
    set: vi.fn(async (items: Store) => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: store[key], newValue: value };
        store[key] = structuredClone(value);
      }
      listeners.forEach((listener) => listener(changes, 'local'));
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      list.forEach((key) => delete store[key]);
    }),
    clear: vi.fn(async () => {
      Object.keys(store).forEach((key) => delete store[key]);
    }),
  };

  const runtime = {
    onMessage: {
      addListener: vi.fn((listener: MessageListener) => {
        messageListeners.push(listener);
      }),
      removeListener: vi.fn((listener: MessageListener) => {
        const index = messageListeners.indexOf(listener);
        if (index >= 0) messageListeners.splice(index, 1);
      }),
      listeners: messageListeners,
    },
    onInstalled: {
      addListener: vi.fn((listener: EventListener) => {
        installedListeners.push(listener);
      }),
      listeners: installedListeners,
    },
    onStartup: {
      addListener: vi.fn((listener: EventListener) => {
        startupListeners.push(listener);
      }),
      listeners: startupListeners,
    },
    sendMessage: vi.fn(async (_message: unknown): Promise<unknown> => undefined),
    getURL: vi.fn(
      (path = ''): string => `chrome-extension://test-extension-id/${path.replace(/^\/+/, '')}`,
    ),
  };

  const tabs = {
    query: vi.fn(async (_queryInfo?: chrome.tabs.QueryInfo): Promise<chrome.tabs.Tab[]> => []),
    sendMessage: vi.fn(
      async (_tabId: number, _message: unknown): Promise<unknown> => undefined,
    ),
  };

  vi.stubGlobal('chrome', {
    storage: {
      local,
      onChanged: {
        addListener: vi.fn((listener) => listeners.push(listener)),
        removeListener: vi.fn((listener) => {
          const index = listeners.indexOf(listener);
          if (index >= 0) listeners.splice(index, 1);
        }),
      },
    },
    runtime,
    tabs,
  });

  return { store, local, runtime, tabs };
}
