import { vi } from 'vitest';

type Store = Record<string, unknown>;

export function installChromeMock(initial: Store = {}) {
  const store: Store = structuredClone(initial);
  const listeners: Array<
    (changes: Record<string, chrome.storage.StorageChange>, area: string) => void
  > = [];

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
  });

  return { store, local };
}
