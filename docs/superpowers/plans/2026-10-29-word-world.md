# Word World 浏览器扩展实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付一个可加载到 Chrome/Edge 的 MV3 扩展，支持网页划词查词与翻译、本地生词本、以及按简化 SRS 在网页上浮现复习。

**Architecture:** background service worker 作为唯一数据与网络网关，content script 通过类型化消息请求查词/复习数据并在 Shadow DOM 中渲染 UI，popup/options/manager 三个 React 页面直接与 SW 通信。生词与设置存 `chrome.storage.local`，SRS 为纯函数便于单测。

**Tech Stack:** Manifest V3、React 18、TypeScript（strict）、Vite 6（三个构建目标）、Vitest。

**Spec:** `docs/superpowers/specs/2026-10-29-word-world-design.md`

## Global Constraints

- MV3；只验收 Chrome / Edge（Chrome ≥ 110），Node ≥ 20，npm。
- TypeScript `strict: true`；不引入 UI 库、不引外部字体/图标/图片资源。
- 所有网络请求与 `chrome.storage` 读写只发生在 service worker 与扩展页面；content script 不直接 `fetch`，也不读取 API Key（只用 `settings:public`）。
- 页面与接口返回内容一律以 React 文本节点渲染，禁止 `innerHTML`。
- 复习默认值：`enabled: true`、`intervalSec: 180`、`displayMode: 'subtitle'`、`position: 'bottom'`、`durationSec: 8`；`intervalSec` 范围 60–1800，`durationSec` 范围 4–30。
- SRS 阶梯：单词 `[0, 1d, 3d, 7d, 16d, 35d]`（stage 0 不用，最高 5），句子 `[0, 1d, 4d, 15d]`（最高 3）；新词 10 分钟后到期；模糊 +60 分钟；不认识 +10 分钟。
- `chrome.storage` 键：`ww.entries.v1`、`ww.settings.v1`、`ww.stats.v1`、`ww.cache.v1`、`ww.schema`。
- 逻辑模块必须有 Vitest 覆盖；UI 任务以「构建通过 + 手动 Chrome 验证」收尾。
- 每个任务结束提交一次 git commit（Task 1 负责 `git init`）。

---

### Task 1: 工程脚手架、构建与 manifest

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `vite.content.config.ts`, `vite.background.config.ts`, `vitest.config.ts`, `.gitignore`
- Create: `public/manifest.json`, `scripts/gen-icons.mjs`
- Create: `popup.html`, `options.html`, `manager.html`
- Create: `src/vite-env.d.ts`, `src/popup/main.tsx`, `src/options/main.tsx`, `src/manager/main.tsx`

**Interfaces:**
- Consumes: 无
- Produces: `npm run build` 产出 `dist/{manifest.json,popup.html,options.html,manager.html,content.js,background.js,icons/*}`；`npm test`（Vitest）、`npm run typecheck` 可用。

- [ ] **Step 1: 写 package.json 与构建配置**

`package.json`:

```json
{
  "name": "word-world",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "build": "rimraf dist && vite build && vite build -c vite.content.config.ts && vite build -c vite.background.config.ts",
    "watch": "concurrently -k \"vite build --watch\" \"vite build --watch -c vite.content.config.ts\" \"vite build --watch -c vite.background.config.ts\"",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit",
    "icons": "node scripts/gen-icons.mjs"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1"
  },
  "devDependencies": {
    "@types/chrome": "^0.0.287",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.4",
    "concurrently": "^9.1.0",
    "rimraf": "^6.0.1",
    "typescript": "^5.7.2",
    "vite": "^6.0.5",
    "vitest": "^2.1.8"
  }
}
```

`tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "types": ["chrome"]
  },
  "include": ["src", "tests", "*.ts"]
}
```

`vite.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    rollupOptions: {
      input: {
        popup: 'popup.html',
        options: 'options.html',
        manager: 'manager.html',
      },
    },
  },
});
```

`vite.content.config.ts`:

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  publicDir: false,
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    cssCodeSplit: false,
    lib: {
      entry: 'src/content/index.tsx',
      formats: ['iife'],
      name: 'WordWorldContent',
      fileName: () => 'content.js',
    },
  },
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
});
```

`vite.background.config.ts`:

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'chrome110',
    lib: {
      entry: 'src/background/index.ts',
      formats: ['es'],
      fileName: () => 'background.js',
    },
  },
});
```

`vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    restoreMocks: true,
  },
});
```

`.gitignore`:

```
node_modules/
dist/
*.local
.DS_Store
```

- [ ] **Step 2: 写 manifest、HTML 入口与临时页面**

`public/manifest.json`:

```json
{
  "manifest_version": 3,
  "name": "Word World",
  "version": "0.1.0",
  "description": "划词查词翻译，生词本与网页复习",
  "permissions": ["storage", "unlimitedStorage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content.js"],
      "run_at": "document_idle",
      "all_frames": false
    }
  ],
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html",
  "icons": {
    "16": "icons/16.png",
    "32": "icons/32.png",
    "48": "icons/48.png",
    "128": "icons/128.png"
  }
}
```

`popup.html`、`options.html`、`manager.html` 三个文件内容相同（只改 title 与入口脚本）：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>Word World</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/popup/main.tsx"></script>
  </body>
</html>
```

`src/popup/main.tsx`（options/manager 的同理，仅入口文件路径不同）：

```tsx
import { createRoot } from 'react-dom/client';

createRoot(document.getElementById('root')!).render(<h1>Word World</h1>);
```

`src/background/index.ts` 临时占位（Task 6 替换）：

```ts
export {};
```

`src/content/index.tsx` 临时占位（Task 7 替换）：

```ts
console.log('[Word World] content loaded');
```

`src/vite-env.d.ts`:

```ts
/// <reference types="vite/client" />

declare module '*.css?inline' {
  const css: string;
  export default css;
}
```

- [ ] **Step 3: 写图标生成脚本**

`scripts/gen-icons.mjs`（无第三方依赖，生成纯色圆角方块 + 白色 W）：

```js
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';

const GLYPH = [
  [1, 0, 0, 0, 1],
  [1, 0, 0, 0, 1],
  [1, 0, 1, 0, 1],
  [1, 1, 0, 1, 1],
  [0, 1, 0, 1, 0],
];

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let crc = 0xffffffff;
  for (const byte of buf) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function insideRounded(x, y, size, radius) {
  const left = x < radius;
  const right = x >= size - radius;
  const top = y < radius;
  const bottom = y >= size - radius;
  if (!(left || right) || !(top || bottom)) return true;
  const cx = left ? radius : size - radius;
  const cy = top ? radius : size - radius;
  const dx = x + 0.5 - cx;
  const dy = y + 0.5 - cy;
  return dx * dx + dy * dy <= radius * radius;
}

function makePng(size) {
  const stride = 1 + size * 4;
  const raw = Buffer.alloc(size * stride);
  const radius = size * 0.22;
  const margin = Math.round(size * 0.24);
  const cell = (size - margin * 2) / 5;
  for (let y = 0; y < size; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < size; x++) {
      const o = y * stride + 1 + x * 4;
      const inside = insideRounded(x, y, size, radius);
      let r = 13, g = 148, b = 136, a = 255;
      if (!inside) {
        a = 0;
      } else {
        const gx = Math.floor((x - margin) / cell);
        const gy = Math.floor((y - margin) / cell);
        if (x >= margin && y >= margin && gx >= 0 && gx < 5 && gy >= 0 && gy < 5 && GLYPH[gy][gx]) {
          r = 255;
          g = 255;
          b = 255;
        }
      }
      raw[o] = r;
      raw[o + 1] = g;
      raw[o + 2] = b;
      raw[o + 3] = a;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync('public/icons', { recursive: true });
for (const size of [16, 32, 48, 128]) {
  writeFileSync(`public/icons/${size}.png`, makePng(size));
}
console.log('icons generated');
```

- [ ] **Step 4: 安装依赖并生成图标**

Run: `npm install`
Run: `npm run icons`
Expected: 输出 `icons generated`，`public/icons/` 下出现 4 个 PNG。

- [ ] **Step 5: 构建并确认产物**

Run: `npm run build`
Expected: 命令成功，`dist/` 下存在 `manifest.json`、`popup.html`、`options.html`、`manager.html`、`content.js`、`background.js`、`icons/16.png`。

- [ ] **Step 6: 类型检查**

Run: `npm run typecheck`
Expected: 无错误输出。

- [ ] **Step 7: 初始化 git 并提交**

```bash
git init
git add -A
git commit -m "chore: scaffold MV3 extension with multi-target Vite build"
```

---

### Task 2: 共享类型、常量与工具函数

**Files:**
- Create: `src/shared/types.ts`, `src/shared/constants.ts`, `src/shared/utils.ts`, `src/shared/http.ts`
- Test: `tests/utils.test.ts`

**Interfaces:**
- Consumes: Task 1 的工程配置
- Produces:
  - `types.ts`: `EntryKind`、`Rating`、`ReviewMode`、`ReviewPosition`、`ProviderMode`、`WordSort`、`Sense`、`SrsState`、`Entry`、`Settings`、`SettingsPatch`、`PublicSettings`、`Stats`、`LookupPayload`、`LookupRequest`、`LookupResponse`、`FallbackReason`、`ErrorCode`、`Result<T>`、`ExportBundle`、`ExtMessage`
  - `constants.ts`: `STORAGE_KEYS`、`SCHEMA_VERSION`、`MAX_SELECTION_LENGTH=400`、`MAX_CONTEXT_LENGTH=300`、`MAX_SENSES=4`、`REQUEST_TIMEOUT_MS=8000`、`CACHE_TTL_MS`、`CACHE_MAX_ENTRIES=500`、`MIN_REVIEW_INTERVAL_SEC=60`、`MAX_REVIEW_INTERVAL_SEC=1800`、`MIN_DURATION_SEC=4`、`MAX_DURATION_SEC=30`、`SKIP_RETRY_MS=30000`、`RECENT_SHOWN_LIMIT=5`、`WORD_INTERVALS_MS`、`SENT_INTERVALS_MS`、`DEFAULT_SETTINGS`
  - `utils.ts`: `normalizeText`、`containsCJK`、`isValidSelection`、`classifySelection`、`isDue`、`formatNextReview`、`localDateKey`、`hostFromUrl`、`sanitizeHttpUrl`、`truncate`、`extractContext`、`delay`
  - `http.ts`: `fetchJson<T>(url, init?, timeoutMs?)`（超时/429/非 2xx 抛 `ProviderError`）

- [ ] **Step 1: 写失败的 utils 测试**

`tests/utils.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  classifySelection,
  containsCJK,
  extractContext,
  formatNextReview,
  hostFromUrl,
  isValidSelection,
  localDateKey,
  normalizeText,
  sanitizeHttpUrl,
} from '../src/shared/utils';

describe('normalizeText', () => {
  it('合并空白并去除首尾空格', () => {
    expect(normalizeText('  hello\n\t world  ')).toBe('hello world');
  });
});

describe('classifySelection', () => {
  it('单个英文单词判为 word', () => {
    expect(classifySelection(' hello ')).toBe('word');
  });

  it('两个英文单词判为 word', () => {
    expect(classifySelection('ice cream')).toBe('word');
  });

  it('带标点的句子判为 sentence', () => {
    expect(classifySelection('This is a sentence.')).toBe('sentence');
  });

  it('中文内容判为 sentence', () => {
    expect(classifySelection('你好世界')).toBe('sentence');
  });
});

describe('isValidSelection', () => {
  it('拒绝空字符串', () => {
    expect(isValidSelection('   ')).toBe(false);
  });

  it('拒绝超过 400 字符', () => {
    expect(isValidSelection('a'.repeat(401))).toBe(false);
  });
});

describe('formatNextReview', () => {
  const now = 1_000_000_000_000;

  it('小于一小时显示分钟', () => {
    expect(formatNextReview(now + 10 * 60_000, now)).toBe('10 分钟后');
  });

  it('整小时显示小时', () => {
    expect(formatNextReview(now + 60 * 60_000, now)).toBe('1 小时后');
  });

  it('多天显示天', () => {
    expect(formatNextReview(now + 3 * 86_400_000, now)).toBe('3 天后');
  });
});

describe('localDateKey', () => {
  it('输出 YYYY-MM-DD', () => {
    expect(localDateKey(new Date(2026, 0, 5, 12).getTime())).toBe('2026-01-05');
  });
});

describe('hostFromUrl / sanitizeHttpUrl', () => {
  it('提取合法 http(s) 主机名', () => {
    expect(hostFromUrl('https://example.com/a?b=1')).toBe('example.com');
  });

  it('拒绝 chrome:// 与非法 URL', () => {
    expect(hostFromUrl('chrome://extensions')).toBeNull();
    expect(hostFromUrl('not a url')).toBeNull();
  });

  it('sanitizeHttpUrl 只保留 http(s)', () => {
    expect(sanitizeHttpUrl('javascript:alert(1)')).toBeUndefined();
    expect(sanitizeHttpUrl('https://example.com/x')).toBe('https://example.com/x');
  });
});

describe('extractContext', () => {
  it('围绕选中词截取上下文', () => {
    const text = 'A quick brown fox jumps over the lazy dog near the river bank';
    const context = extractContext(text, 'fox', 30);
    expect(context).toContain('fox');
    expect(context.length).toBeLessThanOrEqual(30);
  });
});

describe('containsCJK', () => {
  it('识别中文', () => {
    expect(containsCJK('hello 世界')).toBe(true);
    expect(containsCJK('hello world')).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/utils.test.ts`
Expected: FAIL，提示无法解析 `../src/shared/utils`。

- [ ] **Step 3: 实现 shared 模块**

`src/shared/types.ts`:

```ts
export type EntryKind = 'word' | 'sentence';
export type Rating = 'known' | 'unsure' | 'unknown';
export type ReviewMode = 'subtitle' | 'barrage' | 'card';
export type ReviewPosition = 'bottom' | 'top';
export type ProviderMode = 'free' | 'ai';
export type WordSort = 'due' | 'created' | 'lookups';

export interface Sense {
  pos?: string;
  def: string;
}

export interface SrsState {
  stage: number;
  dueAt: number;
  lastReviewedAt?: number;
  reps: number;
  lapses: number;
  knownStreak: number;
}

export interface Entry {
  id: string;
  text: string;
  kind: EntryKind;
  translation: string;
  phonetic?: string;
  senses?: Sense[];
  example?: string;
  context?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  createdAt: number;
  updatedAt: number;
  lookups: number;
  note?: string;
  srs: SrsState;
}

export interface Settings {
  provider: {
    mode: ProviderMode;
    ai: { baseUrl: string; apiKey: string; model: string };
  };
  review: {
    enabled: boolean;
    intervalSec: number;
    displayMode: ReviewMode;
    position: ReviewPosition;
    durationSec: number;
    pausedHosts: string[];
  };
}

export interface SettingsPatch {
  provider?: {
    mode?: ProviderMode;
    ai?: Partial<Settings['provider']['ai']>;
  };
  review?: Partial<Settings['review']>;
}

export interface PublicSettings {
  provider: { mode: ProviderMode };
  review: Settings['review'];
}

export interface Stats {
  date: string;
  shown: number;
  reviewed: number;
  added: number;
}

export interface LookupPayload {
  translation: string;
  phonetic?: string;
  senses?: Sense[];
  example?: string;
}

export interface LookupRequest {
  text: string;
  context?: string;
  sourceUrl?: string;
  sourceTitle?: string;
}

export type FallbackReason = 'ai-unconfigured' | 'ai-error' | 'rate-limit' | null;

export interface LookupResponse {
  entry: Entry;
  provider: ProviderMode;
  cached: boolean;
  fallbackReason: FallbackReason;
}

export interface ExportBundle {
  entries: Entry[];
  settings: Settings;
  exportedAt: number;
}

export type ErrorCode =
  | 'INVALID_PAYLOAD'
  | 'NOT_FOUND'
  | 'NETWORK'
  | 'RATE_LIMIT'
  | 'CONFIG'
  | 'STORAGE'
  | 'UNKNOWN_MESSAGE';

export type Result<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: ErrorCode; message: string } };

export type ExtMessage =
  | { type: 'lookup'; payload: LookupRequest }
  | { type: 'review:next'; payload: { host: string; recentIds: string[] } }
  | { type: 'review:rate'; payload: { id: string; rating: Rating } }
  | {
      type: 'words:list';
      payload: { query?: string; kind?: EntryKind; dueOnly?: boolean; sort?: WordSort };
    }
  | { type: 'words:update'; payload: { id: string; patch: { note?: string; translation?: string } } }
  | { type: 'words:delete'; payload: { id: string } }
  | { type: 'words:clear'; payload: Record<string, never> }
  | {
      type: 'words:import';
      payload: { entries: Entry[]; mode: 'merge' | 'replace' };
    }
  | { type: 'words:export'; payload: Record<string, never> }
  | { type: 'settings:get'; payload: Record<string, never> }
  | { type: 'settings:public'; payload: Record<string, never> }
  | { type: 'settings:update'; payload: SettingsPatch }
  | { type: 'provider:test'; payload: Record<string, never> }
  | { type: 'stats:get'; payload: Record<string, never> }
  | { type: 'review:preview'; payload: { mode: ReviewMode } };
```

`src/shared/constants.ts`:

```ts
import type { Settings } from './types';

export const STORAGE_KEYS = {
  entries: 'ww.entries.v1',
  settings: 'ww.settings.v1',
  stats: 'ww.stats.v1',
  cache: 'ww.cache.v1',
  schema: 'ww.schema',
} as const;

export const SCHEMA_VERSION = 1;
export const MAX_SELECTION_LENGTH = 400;
export const MAX_CONTEXT_LENGTH = 300;
export const MAX_SENSES = 4;
export const REQUEST_TIMEOUT_MS = 8000;
export const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 500;
export const MIN_REVIEW_INTERVAL_SEC = 60;
export const MAX_REVIEW_INTERVAL_SEC = 1800;
export const MIN_DURATION_SEC = 4;
export const MAX_DURATION_SEC = 30;
export const SKIP_RETRY_MS = 30_000;
export const RECENT_SHOWN_LIMIT = 5;

export const WORD_INTERVALS_MS = [
  0,
  86_400_000,
  3 * 86_400_000,
  7 * 86_400_000,
  16 * 86_400_000,
  35 * 86_400_000,
];

export const SENT_INTERVALS_MS = [0, 86_400_000, 4 * 86_400_000, 15 * 86_400_000];

export const DEFAULT_SETTINGS: Settings = {
  provider: {
    mode: 'free',
    ai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' },
  },
  review: {
    enabled: true,
    intervalSec: 180,
    displayMode: 'subtitle',
    position: 'bottom',
    durationSec: 8,
    pausedHosts: [],
  },
};
```

`src/shared/utils.ts`:

```ts
import { MAX_CONTEXT_LENGTH, MAX_SELECTION_LENGTH } from './constants';
import type { Entry, EntryKind } from './types';

export function normalizeText(input: string): string {
  return input.replace(/[\u00a0\u3000]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function containsCJK(text: string): boolean {
  return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}

export function isValidSelection(text: string): boolean {
  const normalized = normalizeText(text);
  return normalized.length > 0 && normalized.length <= MAX_SELECTION_LENGTH;
}

export function classifySelection(input: string): EntryKind {
  const text = normalizeText(input);
  if (!text || containsCJK(text)) return 'sentence';
  if (!/^[A-Za-z][A-Za-z'’\-]*(\s+[A-Za-z][A-Za-z'’\-]*)?$/.test(text)) return 'sentence';
  return 'word';
}

export function isDue(entry: Entry, now: number): boolean {
  return entry.srs.dueAt <= now;
}

export function formatNextReview(dueAt: number, now: number): string {
  const diff = Math.max(0, dueAt - now);
  const minutes = Math.round(diff / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)} 分钟后`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.round(hours / 24)} 天后`;
}

export function localDateKey(now: number): string {
  const date = new Date(now);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function hostFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
}

export function sanitizeHttpUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : undefined;
  } catch {
    return undefined;
  }
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export function extractContext(raw: string, selected: string, max = MAX_CONTEXT_LENGTH): string {
  const text = normalizeText(raw);
  const index = text.indexOf(normalizeText(selected));
  if (index < 0) return truncate(text, max);
  const half = Math.floor((max - selected.length) / 2);
  const start = Math.max(0, index - half);
  return truncate(text.slice(start, index + selected.length + half), max);
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
```

`src/shared/http.ts`:

```ts
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/utils.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 类型检查并提交**

Run: `npm run typecheck`
Expected: 无错误。

```bash
git add src/shared tests/utils.test.ts
git commit -m "feat: add shared types, constants, utils and http helper"
```

---

### Task 3: SRS 纯函数

**Files:**
- Create: `src/background/srs.ts`
- Test: `tests/srs.test.ts`

**Interfaces:**
- Consumes: `Entry`、`Rating`、`EntryKind`、`SrsState`、`WORD_INTERVALS_MS`、`SENT_INTERVALS_MS`
- Produces: `createSrsState(now: number): SrsState`、`rateEntry(entry: Entry, rating: Rating, now: number): Entry`、`pickNext(entries: Entry[], now: number, recentIds?: string[]): Entry | null`、`nextIntervalMs(kind: EntryKind, stage: number): number`

- [ ] **Step 1: 写失败的测试**

`tests/srs.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSrsState, nextIntervalMs, pickNext, rateEntry } from '../src/background/srs';
import type { Entry } from '../src/shared/types';

const NOW = 1_700_000_000_000;

function makeEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: overrides.id ?? 'id-1',
    text: overrides.text ?? 'hello',
    kind: overrides.kind ?? 'word',
    translation: '你好',
    createdAt: NOW,
    updatedAt: NOW,
    lookups: 1,
    srs: createSrsState(NOW),
    ...overrides,
  };
}

describe('createSrsState', () => {
  it('新词 10 分钟后到期', () => {
    const state = createSrsState(NOW);
    expect(state).toMatchObject({ stage: 0, reps: 0, lapses: 0, knownStreak: 0 });
    expect(state.dueAt).toBe(NOW + 10 * 60_000);
  });
});

describe('rateEntry', () => {
  it('认识推进 stage 并按 1 天安排', () => {
    const next = rateEntry(makeEntry(), 'known', NOW);
    expect(next.srs.stage).toBe(1);
    expect(next.srs.knownStreak).toBe(1);
    expect(next.srs.dueAt).toBe(NOW + 86_400_000);
  });

  it('单词 stage 封顶 5，间隔 35 天', () => {
    const entry = makeEntry({ srs: { ...createSrsState(NOW), stage: 5 } });
    const next = rateEntry(entry, 'known', NOW);
    expect(next.srs.stage).toBe(5);
    expect(next.srs.dueAt).toBe(NOW + 35 * 86_400_000);
  });

  it('模糊不改变 stage，1 小时后到期', () => {
    const entry = makeEntry({ srs: { ...createSrsState(NOW), stage: 2 } });
    const next = rateEntry(entry, 'unsure', NOW);
    expect(next.srs.stage).toBe(2);
    expect(next.srs.knownStreak).toBe(0);
    expect(next.srs.dueAt).toBe(NOW + 60 * 60_000);
  });

  it('不认识降低 stage 并累计 lapses', () => {
    const entry = makeEntry({ srs: { ...createSrsState(NOW), stage: 2, lapses: 1 } });
    const next = rateEntry(entry, 'unknown', NOW);
    expect(next.srs.stage).toBe(1);
    expect(next.srs.lapses).toBe(2);
    expect(next.srs.dueAt).toBe(NOW + 10 * 60_000);
  });

  it('句子阶梯封顶 3（15 天）', () => {
    const entry = makeEntry({ kind: 'sentence', srs: { ...createSrsState(NOW), stage: 3 } });
    expect(rateEntry(entry, 'known', NOW).srs.dueAt).toBe(NOW + 15 * 86_400_000);
  });
});

describe('pickNext', () => {
  it('返回最早期到期的条目', () => {
    const early = makeEntry({ id: 'a', srs: { ...createSrsState(NOW), dueAt: NOW - 5000 } });
    const late = makeEntry({ id: 'b', srs: { ...createSrsState(NOW), dueAt: NOW - 1000 } });
    expect(pickNext([late, early], NOW)?.id).toBe('a');
  });

  it('跳过未到期与最近展示过的条目', () => {
    const due = makeEntry({ id: 'a', srs: { ...createSrsState(NOW), dueAt: NOW - 1000 } });
    const notDue = makeEntry({ id: 'b', srs: { ...createSrsState(NOW), dueAt: NOW + 1000 } });
    expect(pickNext([due, notDue], NOW, ['a'])).toBeNull();
  });
});

describe('nextIntervalMs', () => {
  it('越界 stage 取最大档', () => {
    expect(nextIntervalMs('word', 99)).toBe(35 * 86_400_000);
    expect(nextIntervalMs('sentence', 99)).toBe(15 * 86_400_000);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/srs.test.ts`
Expected: FAIL，`src/background/srs` 不存在。

- [ ] **Step 3: 实现 srs.ts**

`src/background/srs.ts`:

```ts
import { SENT_INTERVALS_MS, WORD_INTERVALS_MS } from '../shared/constants';
import type { Entry, EntryKind, Rating, SrsState } from '../shared/types';

const WORD_MAX_STAGE = 5;
const SENT_MAX_STAGE = 3;
const NEW_DELAY_MS = 10 * 60_000;
const UNSURE_DELAY_MS = 60 * 60_000;
const AGAIN_DELAY_MS = 10 * 60_000;

function maxStage(kind: EntryKind): number {
  return kind === 'word' ? WORD_MAX_STAGE : SENT_MAX_STAGE;
}

function intervals(kind: EntryKind): number[] {
  return kind === 'word' ? WORD_INTERVALS_MS : SENT_INTERVALS_MS;
}

export function createSrsState(now: number): SrsState {
  return { stage: 0, dueAt: now + NEW_DELAY_MS, reps: 0, lapses: 0, knownStreak: 0 };
}

export function rateEntry(entry: Entry, rating: Rating, now: number): Entry {
  const srs: SrsState = {
    ...entry.srs,
    lastReviewedAt: now,
    reps: entry.srs.reps + 1,
  };

  if (rating === 'known') {
    srs.stage = Math.min(entry.srs.stage + 1, maxStage(entry.kind));
    srs.knownStreak = entry.srs.knownStreak + 1;
    srs.dueAt = now + intervals(entry.kind)[srs.stage];
  } else if (rating === 'unsure') {
    srs.knownStreak = 0;
    srs.dueAt = now + UNSURE_DELAY_MS;
  } else {
    srs.stage = Math.max(0, entry.srs.stage - 1);
    srs.knownStreak = 0;
    srs.lapses = entry.srs.lapses + 1;
    srs.dueAt = now + AGAIN_DELAY_MS;
  }

  return { ...entry, srs, updatedAt: now };
}

export function pickNext(entries: Entry[], now: number, recentIds: string[] = []): Entry | null {
  const recent = new Set(recentIds);
  const due = entries
    .filter((entry) => entry.srs.dueAt <= now && !recent.has(entry.id))
    .sort((a, b) => a.srs.dueAt - b.srs.dueAt);
  return due[0] ?? null;
}

export function nextIntervalMs(kind: EntryKind, stage: number): number {
  const list = intervals(kind);
  return list[Math.min(stage, maxStage(kind))] ?? 0;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/srs.test.ts`
Expected: 全部 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/background/srs.ts tests/srs.test.ts
git commit -m "feat: implement simplified spaced repetition scheduling"
```

---

### Task 4: 存储层（设置、词条、统计、缓存、导入导出）

**Files:**
- Create: `src/background/storage.ts`
- Test: `tests/helpers/chrome.ts`, `tests/storage.test.ts`

**Interfaces:**
- Consumes: Task 2 类型/常量/工具；Task 3 `createSrsState`
- Produces:
  - `mergeSettings(raw: unknown): Settings`
  - `getSettings(): Promise<Settings>`
  - `updateSettings(patch: SettingsPatch): Promise<Settings>`
  - `getPublicSettings(): Promise<PublicSettings>`
  - `getEntriesMap(): Promise<Record<string, Entry>>`
  - `saveEntry(entry: Entry): Promise<void>`
  - `getEntry(id: string): Promise<Entry | null>`
  - `listEntries(filter: { query?: string; kind?: EntryKind; dueOnly?: boolean; sort?: WordSort }, now: number): Promise<Entry[]>`
  - `deleteEntry(id: string): Promise<boolean>`
  - `clearEntries(): Promise<void>`
  - `upsertLookup(input: { id: string; text: string; kind: EntryKind; payload: LookupPayload; context?: string; sourceUrl?: string; sourceTitle?: string }, now: number): Promise<{ entry: Entry; created: boolean }>`
  - `getStats(now: number): Promise<Stats>`
  - `bumpStat(key: 'shown' | 'reviewed' | 'added', now: number): Promise<Stats>`
  - `getCached(key: string, now: number): Promise<LookupPayload | null>`
  - `setCached(key: string, result: LookupPayload, now: number): Promise<void>`
  - `trimCache(cache: Record<string, CacheRecord>, max: number): Record<string, CacheRecord>`
  - `isValidEntry(raw: unknown): raw is Entry`
  - `importEntries(raw: unknown[], mode: 'merge' | 'replace'): Promise<{ imported: number; skipped: number }>`
  - `buildExport(now: number): Promise<ExportBundle>`
  - `ensureSchema(): Promise<void>`

- [ ] **Step 1: 写 chrome.storage mock 助手**

`tests/helpers/chrome.ts`:

```ts
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
```

- [ ] **Step 2: 写失败的存储测试**

`tests/storage.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { installChromeMock } from './helpers/chrome';
import {
  buildExport,
  bumpStat,
  getCached,
  getSettings,
  importEntries,
  setCached,
  trimCache,
  upsertLookup,
  isValidEntry,
} from '../src/background/storage';
import { CACHE_MAX_ENTRIES, DEFAULT_SETTINGS, STORAGE_KEYS } from '../src/shared/constants';
import type { Entry } from '../src/shared/types';

const NOW = 1_700_000_000_000;

function sampleEntry(overrides: Partial<Entry> = {}): Entry {
  return {
    id: 'e1',
    text: 'hello',
    kind: 'word',
    translation: '你好',
    createdAt: NOW,
    updatedAt: NOW,
    lookups: 1,
    srs: { stage: 0, dueAt: NOW + 600_000, reps: 0, lapses: 0, knownStreak: 0 },
    ...overrides,
  };
}

let store: Record<string, unknown>;

beforeEach(() => {
  store = installChromeMock().store;
});

describe('settings', () => {
  it('无存储时返回默认设置', async () => {
    expect(await getSettings()).toEqual(DEFAULT_SETTINGS);
  });

  it('合并时钳制范围并丢弃未知值', async () => {
    store[STORAGE_KEYS.settings] = {
      review: { intervalSec: 5, displayMode: 'bogus', durationSec: 99, pausedHosts: ['a.com', 3] },
      provider: { mode: 'ai' },
    };
    const settings = await getSettings();
    expect(settings.review.intervalSec).toBe(60);
    expect(settings.review.displayMode).toBe('subtitle');
    expect(settings.review.durationSec).toBe(30);
    expect(settings.review.pausedHosts).toEqual(['a.com']);
    expect(settings.provider.ai.model).toBe(DEFAULT_SETTINGS.provider.ai.model);
  });
});

describe('stats', () => {
  it('跨天重置计数', async () => {
    store[STORAGE_KEYS.stats] = { date: '2000-01-01', shown: 9, reviewed: 9, added: 9 };
    const stats = await bumpStat('shown', NOW);
    expect(stats.shown).toBe(1);
    expect(stats.reviewed).toBe(0);
    expect(stats.date).not.toBe('2000-01-01');
  });
});

describe('cache', () => {
  it('命中未过期缓存', async () => {
    await setCached('free:hello', { translation: '你好' }, NOW);
    expect(await getCached('free:hello', NOW + 1000)).toEqual({ translation: '你好' });
  });

  it('过期缓存返回 null', async () => {
    await setCached('free:hello', { translation: '你好' }, NOW);
    expect(await getCached('free:hello', NOW + 8 * 86_400_000)).toBeNull();
  });

  it('trimCache 淘汰最旧条目', () => {
    const cache = Object.fromEntries(
      Array.from({ length: 5 }, (_, i) => [
        `k${i}`,
        { result: { translation: 'x' }, cachedAt: i },
      ]),
    );
    const trimmed = trimCache(cache, 3);
    expect(Object.keys(trimmed).sort()).toEqual(['k2', 'k3', 'k4']);
    expect(CACHE_MAX_ENTRIES).toBe(500);
  });
});

describe('entries', () => {
  it('首次查询创建词条', async () => {
    const result = await upsertLookup(
      { id: 'e1', text: 'hello', kind: 'word', payload: { translation: '你好' } },
      NOW,
    );
    expect(result.created).toBe(true);
    expect(result.entry.lookups).toBe(1);
    expect(result.entry.srs.dueAt).toBe(NOW + 600_000);
  });

  it('重复查询累加 lookups 并将 dueAt 提前到当前时间', async () => {
    await upsertLookup(
      { id: 'e1', text: 'hello', kind: 'word', payload: { translation: '你好' } },
      NOW,
    );
    const later = NOW + 120_000;
    const result = await upsertLookup(
      { id: 'e2', text: 'Hello', kind: 'word', payload: { translation: '喂' } },
      later,
    );
    expect(result.created).toBe(false);
    expect(result.entry.id).toBe('e1');
    expect(result.entry.lookups).toBe(2);
    expect(result.entry.srs.dueAt).toBe(later);
  });

  it('导入时跳过非法条目并统计', async () => {
    const result = await importEntries(
      [sampleEntry({ id: 'ok' }), { id: 'bad' }, null],
      'merge',
    );
    expect(result).toEqual({ imported: 1, skipped: 2 });
  });

  it('isValidEntry 校验必需字段', () => {
    expect(isValidEntry(sampleEntry())).toBe(true);
    expect(isValidEntry({ ...sampleEntry(), srs: {} })).toBe(false);
  });

  it('导出时移除 API Key', async () => {
    store[STORAGE_KEYS.settings] = {
      ...DEFAULT_SETTINGS,
      provider: { mode: 'ai', ai: { baseUrl: 'https://x/v1', apiKey: 'secret', model: 'm' } },
    };
    const bundle = await buildExport(NOW);
    expect(bundle.settings.provider.ai.apiKey).toBe('');
    expect(bundle.exportedAt).toBe(NOW);
  });
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL，`src/background/storage` 不存在。

- [ ] **Step 4: 实现 storage.ts**

`src/background/storage.ts`:

```ts
import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  DEFAULT_SETTINGS,
  MAX_DURATION_SEC,
  MAX_REVIEW_INTERVAL_SEC,
  MIN_DURATION_SEC,
  MIN_REVIEW_INTERVAL_SEC,
  SCHEMA_VERSION,
  STORAGE_KEYS,
} from '../shared/constants';
import type {
  Entry,
  EntryKind,
  ExportBundle,
  LookupPayload,
  PublicSettings,
  Settings,
  SettingsPatch,
  Stats,
  WordSort,
} from '../shared/types';
import { createSrsState } from './srs';
import { localDateKey } from '../shared/utils';

export interface CacheRecord {
  result: LookupPayload;
  cachedAt: number;
}

type EntryMap = Record<string, Entry>;
type CacheMap = Record<string, CacheRecord>;

async function readKey<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function writeKey(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function mergeSettings(raw: unknown): Settings {
  const source = (raw ?? {}) as Record<string, any>;
  const defaults = DEFAULT_SETTINGS;
  const ai = source.provider?.ai ?? {};
  const review = source.review ?? {};

  return {
    provider: {
      mode: source.provider?.mode === 'ai' ? 'ai' : 'free',
      ai: {
        baseUrl:
          typeof ai.baseUrl === 'string' && ai.baseUrl ? ai.baseUrl : defaults.provider.ai.baseUrl,
        apiKey: typeof ai.apiKey === 'string' ? ai.apiKey : '',
        model: typeof ai.model === 'string' && ai.model ? ai.model : defaults.provider.ai.model,
      },
    },
    review: {
      enabled: typeof review.enabled === 'boolean' ? review.enabled : defaults.review.enabled,
      intervalSec: clampInt(
        review.intervalSec,
        defaults.review.intervalSec,
        MIN_REVIEW_INTERVAL_SEC,
        MAX_REVIEW_INTERVAL_SEC,
      ),
      displayMode: ['subtitle', 'barrage', 'card'].includes(review.displayMode)
        ? review.displayMode
        : defaults.review.displayMode,
      position: review.position === 'top' ? 'top' : 'bottom',
      durationSec: clampInt(
        review.durationSec,
        defaults.review.durationSec,
        MIN_DURATION_SEC,
        MAX_DURATION_SEC,
      ),
      pausedHosts: Array.isArray(review.pausedHosts)
        ? review.pausedHosts.filter((host: unknown): host is string => typeof host === 'string')
        : [],
    },
  };
}

export async function getSettings(): Promise<Settings> {
  return mergeSettings(await readKey<unknown>(STORAGE_KEYS.settings));
}

export async function updateSettings(patch: SettingsPatch): Promise<Settings> {
  const current = await getSettings();
  const next = mergeSettings({
    provider: {
      ...current.provider,
      ...patch.provider,
      ai: { ...current.provider.ai, ...patch.provider?.ai },
    },
    review: { ...current.review, ...patch.review },
  });
  await writeKey(STORAGE_KEYS.settings, next);
  return next;
}

export async function getPublicSettings(): Promise<PublicSettings> {
  const settings = await getSettings();
  return { provider: { mode: settings.provider.mode }, review: settings.review };
}

export async function getEntriesMap(): Promise<EntryMap> {
  return (await readKey<EntryMap>(STORAGE_KEYS.entries)) ?? {};
}

async function writeEntriesMap(map: EntryMap): Promise<void> {
  await writeKey(STORAGE_KEYS.entries, map);
}

export async function getEntry(id: string): Promise<Entry | null> {
  const map = await getEntriesMap();
  return map[id] ?? null;
}

export async function saveEntry(entry: Entry): Promise<void> {
  const map = await getEntriesMap();
  map[entry.id] = entry;
  await writeEntriesMap(map);
}

export async function listEntries(
  filter: { query?: string; kind?: EntryKind; dueOnly?: boolean; sort?: WordSort },
  now: number,
): Promise<Entry[]> {
  const map = await getEntriesMap();
  const query = filter.query?.trim().toLowerCase();
  let entries = Object.values(map);

  if (query) {
    entries = entries.filter(
      (entry) =>
        entry.text.toLowerCase().includes(query) ||
        entry.translation.toLowerCase().includes(query) ||
        (entry.note ?? '').toLowerCase().includes(query),
    );
  }
  if (filter.kind) entries = entries.filter((entry) => entry.kind === filter.kind);
  if (filter.dueOnly) entries = entries.filter((entry) => entry.srs.dueAt <= now);

  const sort = filter.sort ?? 'created';
  entries.sort((a, b) => {
    if (sort === 'due') return a.srs.dueAt - b.srs.dueAt;
    if (sort === 'lookups') return b.lookups - a.lookups;
    return b.createdAt - a.createdAt;
  });
  return entries;
}

export async function deleteEntry(id: string): Promise<boolean> {
  const map = await getEntriesMap();
  if (!map[id]) return false;
  delete map[id];
  await writeEntriesMap(map);
  return true;
}

export async function clearEntries(): Promise<void> {
  await writeEntriesMap({});
}

export async function upsertLookup(
  input: {
    id: string;
    text: string;
    kind: EntryKind;
    payload: LookupPayload;
    context?: string;
    sourceUrl?: string;
    sourceTitle?: string;
  },
  now: number,
): Promise<{ entry: Entry; created: boolean }> {
  const map = await getEntriesMap();
  const needle = input.text.toLowerCase();
  const existing = Object.values(map).find(
    (entry) => entry.kind === input.kind && entry.text.toLowerCase() === needle,
  );

  if (existing) {
    const entry: Entry = {
      ...existing,
      translation: input.payload.translation || existing.translation,
      phonetic: input.payload.phonetic ?? existing.phonetic,
      senses: input.payload.senses ?? existing.senses,
      example: input.payload.example ?? existing.example,
      context: input.context ?? existing.context,
      sourceUrl: input.sourceUrl ?? existing.sourceUrl,
      sourceTitle: input.sourceTitle ?? existing.sourceTitle,
      lookups: existing.lookups + 1,
      updatedAt: now,
      srs: { ...existing.srs, dueAt: Math.min(existing.srs.dueAt, now) },
    };
    map[entry.id] = entry;
    await writeEntriesMap(map);
    return { entry, created: false };
  }

  const entry: Entry = {
    id: input.id,
    text: input.text,
    kind: input.kind,
    translation: input.payload.translation,
    phonetic: input.payload.phonetic,
    senses: input.payload.senses,
    example: input.payload.example,
    context: input.context,
    sourceUrl: input.sourceUrl,
    sourceTitle: input.sourceTitle,
    createdAt: now,
    updatedAt: now,
    lookups: 1,
    srs: createSrsState(now),
  };
  map[entry.id] = entry;
  await writeEntriesMap(map);
  return { entry, created: true };
}

export async function getStats(now: number): Promise<Stats> {
  const raw = await readKey<Stats>(STORAGE_KEYS.stats);
  const date = localDateKey(now);
  if (!raw || raw.date !== date) {
    return { date, shown: 0, reviewed: 0, added: 0 };
  }
  return {
    date,
    shown: raw.shown ?? 0,
    reviewed: raw.reviewed ?? 0,
    added: raw.added ?? 0,
  };
}

export async function bumpStat(
  key: 'shown' | 'reviewed' | 'added',
  now: number,
): Promise<Stats> {
  const stats = await getStats(now);
  stats[key] += 1;
  await writeKey(STORAGE_KEYS.stats, stats);
  return stats;
}

export function trimCache(cache: CacheMap, max: number): CacheMap {
  const keys = Object.keys(cache);
  if (keys.length <= max) return cache;
  keys
    .sort((a, b) => cache[a].cachedAt - cache[b].cachedAt)
    .slice(0, keys.length - max)
    .forEach((key) => delete cache[key]);
  return cache;
}

export async function getCached(key: string, now: number): Promise<LookupPayload | null> {
  const cache = (await readKey<CacheMap>(STORAGE_KEYS.cache)) ?? {};
  const record = cache[key];
  if (!record || now - record.cachedAt > CACHE_TTL_MS) return null;
  return record.result;
}

export async function setCached(
  key: string,
  result: LookupPayload,
  now: number,
): Promise<void> {
  const cache = (await readKey<CacheMap>(STORAGE_KEYS.cache)) ?? {};
  cache[key] = { result, cachedAt: now };
  await writeKey(STORAGE_KEYS.cache, trimCache(cache, CACHE_MAX_ENTRIES));
}

export function isValidEntry(raw: unknown): raw is Entry {
  if (!raw || typeof raw !== 'object') return false;
  const entry = raw as Record<string, any>;
  return (
    typeof entry.id === 'string' &&
    typeof entry.text === 'string' &&
    (entry.kind === 'word' || entry.kind === 'sentence') &&
    typeof entry.translation === 'string' &&
    typeof entry.createdAt === 'number' &&
    typeof entry.updatedAt === 'number' &&
    typeof entry.lookups === 'number' &&
    !!entry.srs &&
    typeof entry.srs.stage === 'number' &&
    typeof entry.srs.dueAt === 'number' &&
    typeof entry.srs.reps === 'number'
  );
}

export async function importEntries(
  raw: unknown[],
  mode: 'merge' | 'replace',
): Promise<{ imported: number; skipped: number }> {
  const map: EntryMap = mode === 'replace' ? {} : await getEntriesMap();
  let imported = 0;
  let skipped = 0;

  for (const candidate of raw) {
    if (!isValidEntry(candidate)) {
      skipped += 1;
      continue;
    }
    const existing = map[candidate.id];
    if (existing && existing.updatedAt > candidate.updatedAt) {
      skipped += 1;
      continue;
    }
    map[candidate.id] = candidate;
    imported += 1;
  }

  await writeEntriesMap(map);
  return { imported, skipped };
}

export async function buildExport(now: number): Promise<ExportBundle> {
  const map = await getEntriesMap();
  const settings = await getSettings();
  return {
    entries: Object.values(map),
    settings: {
      ...settings,
      provider: { ...settings.provider, ai: { ...settings.provider.ai, apiKey: '' } },
    },
    exportedAt: now,
  };
}

export async function ensureSchema(): Promise<void> {
  const version = await readKey<number>(STORAGE_KEYS.schema);
  if (version !== SCHEMA_VERSION) {
    await writeKey(STORAGE_KEYS.schema, SCHEMA_VERSION);
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/storage.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 提交**

```bash
git add src/background/storage.ts tests/helpers/chrome.ts tests/storage.test.ts
git commit -m "feat: add storage layer with settings, entries, stats, cache and import/export"
```

---

### Task 5: 数据源（免费词典/翻译 + AI）

**Files:**
- Create: `src/background/providers/free.ts`, `src/background/providers/ai.ts`, `src/background/providers/index.ts`
- Test: `tests/providers.test.ts`

**Interfaces:**
- Consumes: `fetchJson`、`ProviderError`（Task 2）；`getCached`/`setCached`（Task 4）；`classifySelection`、`normalizeText`、`containsCJK`
- Produces:
  - `freeLookup(text: string, kind: EntryKind): Promise<LookupPayload>`
  - `translateText(text: string): Promise<string>`
  - `aiLookup(text: string, kind: EntryKind, context: string | undefined, cfg: Settings['provider']['ai']): Promise<LookupPayload>`
  - `parseAiPayload(content: string): LookupPayload`
  - `resolveLookup(text: string, context: string | undefined, settings: Settings): Promise<{ payload: LookupPayload; provider: ProviderMode; cached: boolean; fallbackReason: FallbackReason }>`

- [ ] **Step 1: 写失败的测试**

`tests/providers.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome';
import { parseAiPayload, resolveLookup, aiLookup } from '../src/background/providers';
import { freeLookup, translateText } from '../src/background/providers/free';
import { DEFAULT_SETTINGS } from '../src/shared/constants';
import type { Settings } from '../src/shared/types';

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

const DICT = [
  {
    word: 'hello',
    phonetic: '/həˈləʊ/',
    meanings: [
      {
        partOfSpeech: 'exclamation',
        definitions: [{ definition: 'used as a greeting', example: 'hello there' }],
      },
    ],
  },
];

const GOOGLE = [[['你好', 'hello', null, null]]];

describe('free provider', () => {
  beforeEach(() => {
    installChromeMock();
  });

  it('单词返回音标、释义、例句与译义', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
      ),
    );
    const result = await freeLookup('hello', 'word');
    expect(result.translation).toBe('你好');
    expect(result.phonetic).toBe('/həˈləʊ/');
    expect(result.senses?.[0]).toEqual({ pos: 'exclamation', def: 'used as a greeting' });
    expect(result.example).toBe('hello there');
  });

  it('Google 失败时回退 MyMemory', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('translate.googleapis')) return json({}, 500);
        if (url.includes('mymemory')) return json({ responseStatus: 200, responseData: { translatedText: '世界' } });
        return json(DICT);
      }),
    );
    await expect(translateText('world')).resolves.toBe('世界');
  });

  it('词典失败但翻译成功仍返回条目', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json({}, 404) : json(GOOGLE),
      ),
    );
    const result = await freeLookup('hello', 'word');
    expect(result.translation).toBe('你好');
    expect(result.senses).toBeUndefined();
  });
});

describe('ai provider', () => {
  beforeEach(() => {
    installChromeMock();
  });

  it('解析 fenced JSON', () => {
    const payload = parseAiPayload('```json\n{"translation":"你好","phonetic":"/h/","senses":[{"pos":"int.","def":"问候"}],"example":"hi"}\n```');
    expect(payload).toEqual({
      translation: '你好',
      phonetic: '/h/',
      senses: [{ pos: 'int.', def: '问候' }],
      example: 'hi',
    });
  });

  it('缺少 translation 时抛错', () => {
    expect(() => parseAiPayload('{"foo":1}')).toThrow();
  });

  it('未配置 Key 抛 CONFIG', async () => {
    await expect(
      aiLookup('hello', 'word', undefined, { baseUrl: 'https://x/v1', apiKey: '', model: 'm' }),
    ).rejects.toMatchObject({ code: 'CONFIG' });
  });

  it('调用 chat/completions 并解析结果', async () => {
    const fetchMock = vi.fn(async () =>
      json({ choices: [{ message: { content: '{"translation":"你好"}' } }] }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const payload = await aiLookup('hello', 'word', 'say hello', {
      baseUrl: 'https://x/v1/',
      apiKey: 'k',
      model: 'm',
    });
    expect(payload.translation).toBe('你好');
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://x/v1/chat/completions');
  });
});

describe('resolveLookup', () => {
  beforeEach(() => {
    installChromeMock();
  });

  const aiSettings: Settings = {
    ...DEFAULT_SETTINGS,
    provider: { mode: 'ai', ai: { baseUrl: 'https://x/v1', apiKey: 'k', model: 'm' } },
  };

  it('AI 失败回退 free 且标记 fallbackReason', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
      ),
    );
    const result = await resolveLookup('hello', undefined, aiSettings);
    expect(result.provider).toBe('free');
    expect(result.fallbackReason).toBe('ai-error');
  });

  it('AI 未配置 Key 直接走 free', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
      ),
    );
    const result = await resolveLookup('hello', undefined, DEFAULT_SETTINGS);
    expect(result.provider).toBe('free');
    expect(result.fallbackReason).toBeNull();
  });

  it('第二次查询命中缓存', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('dictionaryapi') ? json(DICT) : json(GOOGLE),
    );
    vi.stubGlobal('fetch', fetchMock);
    await resolveLookup('hello', undefined, DEFAULT_SETTINGS);
    const second = await resolveLookup('hello', undefined, DEFAULT_SETTINGS);
    expect(second.cached).toBe(true);
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(3);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/providers.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 free.ts**

`src/background/providers/free.ts`:

```ts
import { MAX_SENSES } from '../../shared/constants';
import { fetchJson, ProviderError } from '../../shared/http';
import type { EntryKind, LookupPayload, Sense } from '../../shared/types';
import { containsCJK } from '../../shared/utils';

interface DictEntry {
  word?: string;
  phonetic?: string;
  phonetics?: Array<{ text?: string }>;
  meanings?: Array<{
    partOfSpeech?: string;
    definitions?: Array<{ definition: string; example?: string }>;
  }>;
}

async function dictionaryLookup(word: string): Promise<Partial<LookupPayload>> {
  const data = await fetchJson<DictEntry[]>(
    `https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`,
  );
  const first = Array.isArray(data) ? data[0] : undefined;
  if (!first) throw new ProviderError('NETWORK', '未找到释义');

  const phonetic = first.phonetic || first.phonetics?.find((item) => item.text)?.text;
  const senses: Sense[] = [];
  let example: string | undefined;

  for (const meaning of first.meanings ?? []) {
    for (const definition of meaning.definitions ?? []) {
      if (senses.length >= MAX_SENSES) break;
      senses.push({ pos: meaning.partOfSpeech, def: definition.definition });
      example ??= definition.example;
    }
    if (senses.length >= MAX_SENSES) break;
  }
  if (!senses.length) throw new ProviderError('NETWORK', '未找到释义');
  return { phonetic, senses, example };
}

async function googleTranslate(text: string, target: string): Promise<string> {
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx' +
    `&sl=auto&tl=${target}&dt=t&q=${encodeURIComponent(text)}`;
  const data = await fetchJson<unknown[]>(url);
  const segments = Array.isArray(data?.[0]) ? (data[0] as unknown[][]) : [];
  const translated = segments.map((segment) => segment?.[0] ?? '').join('');
  if (!translated.trim()) throw new ProviderError('NETWORK', '翻译结果为空');
  return translated;
}

async function myMemoryTranslate(text: string, source: string, target: string): Promise<string> {
  const url =
    'https://api.mymemory.translated.net/get' +
    `?q=${encodeURIComponent(text.slice(0, 500))}&langpair=${source}|${target}`;
  const data = await fetchJson<{
    responseStatus?: number;
    responseData?: { translatedText?: string };
  }>(url);
  const translated = data.responseData?.translatedText?.trim();
  if (!translated || data.responseStatus !== 200) {
    throw new ProviderError('RATE_LIMIT', '翻译接口限流，请稍后再试');
  }
  return translated;
}

export async function translateText(text: string): Promise<string> {
  const target = containsCJK(text) ? 'en' : 'zh-CN';
  const source = target === 'en' ? 'zh-CN' : 'en';
  try {
    return await googleTranslate(text, target);
  } catch {
    return myMemoryTranslate(text, source, target);
  }
}

export async function freeLookup(text: string, kind: EntryKind): Promise<LookupPayload> {
  let dictionary: Partial<LookupPayload> = {};
  let dictionaryError: unknown;
  if (kind === 'word') {
    try {
      dictionary = await dictionaryLookup(text);
    } catch (error) {
      dictionaryError = error;
    }
  }

  let translation = '';
  let translateError: unknown;
  try {
    translation = await translateText(text);
  } catch (error) {
    translateError = error;
  }

  if (!translation && !dictionary.senses?.length) {
    if (translateError instanceof ProviderError) throw translateError;
    if (dictionaryError instanceof ProviderError) throw dictionaryError;
    throw new ProviderError('NETWORK', '查询失败，请稍后重试');
  }

  return { translation, ...dictionary };
}
```

- [ ] **Step 4: 实现 ai.ts 与 providers/index.ts**

`src/background/providers/ai.ts`:

```ts
import { MAX_SENSES } from '../../shared/constants';
import { fetchJson, ProviderError } from '../../shared/http';
import type { EntryKind, LookupPayload, Sense, Settings } from '../../shared/types';

export function parseAiPayload(content: string): LookupPayload {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new ProviderError('NETWORK', 'AI 返回格式无效');
  }

  let parsed: any;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    throw new ProviderError('NETWORK', 'AI 返回格式无效');
  }

  if (typeof parsed?.translation !== 'string' || !parsed.translation.trim()) {
    throw new ProviderError('NETWORK', 'AI 返回缺少译文');
  }

  const senses: Sense[] | undefined = Array.isArray(parsed.senses)
    ? parsed.senses
        .filter((sense: any) => sense && typeof sense.def === 'string')
        .slice(0, MAX_SENSES)
        .map((sense: any) => ({
          pos: typeof sense.pos === 'string' ? sense.pos : undefined,
          def: sense.def,
        }))
    : undefined;

  return {
    translation: parsed.translation.trim(),
    phonetic: typeof parsed.phonetic === 'string' ? parsed.phonetic : undefined,
    senses: senses?.length ? senses : undefined,
    example: typeof parsed.example === 'string' ? parsed.example : undefined,
  };
}

export async function aiLookup(
  text: string,
  kind: EntryKind,
  context: string | undefined,
  cfg: Settings['provider']['ai'],
): Promise<LookupPayload> {
  if (!cfg.apiKey) throw new ProviderError('CONFIG', '未配置 AI API Key');

  const userPrompt =
    kind === 'word'
      ? `查询英文单词：${text}\n${context ? `上下文：${context}\n` : ''}返回 JSON：{"translation":"中文释义","phonetic":"音标(可空)","senses":[{"pos":"n.","def":"中文释义"}],"example":"英文例句(可空)"}`
      : `把下面的内容翻译成中文（若原文为中文则翻译成英文）：${text}\n只返回 JSON：{"translation":"译文"}`;

  const data = await fetchJson<{ choices?: Array<{ message?: { content?: string } }> }>(
    `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        messages: [
          { role: 'system', content: '只输出 JSON，不要任何解释或 markdown 代码围栏。' },
          { role: 'user', content: userPrompt },
        ],
      }),
    },
  );

  const content = data.choices?.[0]?.message?.content ?? '';
  return parseAiPayload(content);
}
```

`src/background/providers/index.ts`:

```ts
import { getCached, setCached } from '../storage';
import type {
  EntryKind,
  FallbackReason,
  LookupPayload,
  ProviderMode,
  Settings,
} from '../../shared/types';
import { classifySelection, normalizeText } from '../../shared/utils';
import { ProviderError } from '../../shared/http';
import { aiLookup } from './ai';
import { freeLookup } from './free';

export { aiLookup, parseAiPayload } from './ai';
export { freeLookup, translateText } from './free';
export { ProviderError } from '../../shared/http';

export interface LookupOutcome {
  payload: LookupPayload;
  provider: ProviderMode;
  cached: boolean;
  fallbackReason: FallbackReason;
}

async function fallbackToFree(
  text: string,
  kind: EntryKind,
  reason: FallbackReason,
  now: number,
): Promise<LookupOutcome> {
  const payload = await freeLookup(text, kind);
  await setCached(`free:${text.toLowerCase()}`, payload, now);
  return { payload, provider: 'free', cached: false, fallbackReason: reason };
}

export async function resolveLookup(
  rawText: string,
  context: string | undefined,
  settings: Settings,
): Promise<LookupOutcome> {
  const text = normalizeText(rawText);
  const kind = classifySelection(text);
  const now = Date.now();
  const mode = settings.provider.mode;
  const cacheKey = `${mode}:${text.toLowerCase()}`;

  const cached = await getCached(cacheKey, now);
  if (cached) {
    return { payload: cached, provider: mode, cached: true, fallbackReason: null };
  }

  if (mode === 'ai') {
    if (!settings.provider.ai.apiKey) {
      return fallbackToFree(text, kind, 'ai-unconfigured', now);
    }
    try {
      const payload = await aiLookup(text, kind, context, settings.provider.ai);
      await setCached(cacheKey, payload, now);
      return { payload, provider: 'ai', cached: false, fallbackReason: null };
    } catch {
      try {
        return await fallbackToFree(text, kind, 'ai-error', now);
      } catch (error) {
        if (error instanceof ProviderError) throw error;
        throw new ProviderError('NETWORK', '查询失败，请稍后重试');
      }
    }
  }

  try {
    const payload = await freeLookup(text, kind);
    await setCached(cacheKey, payload, now);
    return { payload, provider: 'free', cached: false, fallbackReason: null };
  } catch (error) {
    if (error instanceof ProviderError) throw error;
    throw new ProviderError('NETWORK', '查询失败，请稍后重试');
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/providers.test.ts`
Expected: 全部 PASS。若 `resolveLookup` 缓存测试因 3 次 fetch 断言失败，确认第一次查询共 2 次请求（词典 + 翻译），第二次 0 次。

- [ ] **Step 6: 提交**

```bash
git add src/background/providers tests/providers.test.ts
git commit -m "feat: add free and AI lookup providers with fallback and cache"
```

---

### Task 6: 消息协议与 background 入口

**Files:**
- Create: `src/shared/messages.ts`, `src/background/messages.ts`
- Modify: `src/background/index.ts`
- Test: `tests/messages.test.ts`

**Interfaces:**
- Consumes: Task 4 全部存储函数；Task 5 `resolveLookup`；Task 3 `rateEntry`/`pickNext`
- Produces:
  - `isExtMessage(value: unknown): value is ExtMessage`
  - `sendToBackground<T>(message: ExtMessage): Promise<Result<T>>`
  - `handleMessage(message: ExtMessage, now?: number): Promise<Result<unknown>>`
  - `previewActiveTab(mode: ReviewMode): Promise<Result<{ shown: boolean }>>`

- [ ] **Step 1: 写失败的消息测试**

`tests/messages.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock } from './helpers/chrome';
import { handleMessage } from '../src/background/messages';
import { getEntriesMap, getSettings, getStats, updateSettings } from '../src/background/storage';
import { STORAGE_KEYS } from '../src/shared/constants';
import type { Entry, Settings } from '../src/shared/types';

const NOW = 1_700_000_000_000;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status });
}

function mockFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('dictionaryapi')) {
        return json([
          {
            word: 'hello',
            phonetic: '/həˈləʊ/',
            meanings: [
              {
                partOfSpeech: 'exclamation',
                definitions: [{ definition: 'used as a greeting', example: 'hello there' }],
              },
            ],
          },
        ]);
      }
      return json([[['你好', 'hello']]]);
    }),
  );
}

let store: Record<string, unknown>;

beforeEach(() => {
  store = installChromeMock().store;
});

describe('lookup', () => {
  beforeEach(() => {
    mockFetch();
  });

  it('拒绝空文本', async () => {
    const result = await handleMessage({ type: 'lookup', payload: { text: '   ' } }, NOW);
    expect(result.ok).toBe(false);
  });

  it('查询成功后写入生词本并统计 added', async () => {
    const result = await handleMessage(
      {
        type: 'lookup',
        payload: { text: 'hello', context: 'say hello', sourceUrl: 'https://example.com/a' },
      },
      NOW,
    );
    expect(result.ok).toBe(true);
    const entries = Object.values(await getEntriesMap());
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('hello');
    expect(entries[0].sourceUrl).toBe('https://example.com/a');
    expect((await getStats(NOW)).added).toBe(1);
  });
});

describe('review', () => {
  beforeEach(() => {
    store[STORAGE_KEYS.entries] = {
      e1: {
        id: 'e1',
        text: 'hello',
        kind: 'word',
        translation: '你好',
        createdAt: NOW - 1000,
        updatedAt: NOW - 1000,
        lookups: 1,
        srs: {
          stage: 1,
          dueAt: NOW - 1,
          reps: 1,
          lapses: 0,
          knownStreak: 1,
        },
      } satisfies Entry,
    };
  });

  it('返回到期词条并增加 shown', async () => {
    const result = await handleMessage(
      { type: 'review:next', payload: { host: 'example.com', recentIds: [] } },
      NOW,
    );
    expect(result.ok).toBe(true);
    const data = (result as { data: Entry | null }).data;
    expect(data?.id).toBe('e1');
    expect((await getStats(NOW)).shown).toBe(1);
  });

  it('站点暂停时不返回词条', async () => {
    await updateSettings({ review: { pausedHosts: ['example.com'] } });
    const result = await handleMessage(
      { type: 'review:next', payload: { host: 'example.com', recentIds: [] } },
      NOW,
    );
    expect((result as { data: Entry | null }).data).toBeNull();
  });

  it('评分推进 SRS 并增加 reviewed', async () => {
    const result = await handleMessage(
      { type: 'review:rate', payload: { id: 'e1', rating: 'known' } },
      NOW,
    );
    expect(result.ok).toBe(true);
    const data = (result as { data: { entry: Entry } }).data;
    expect(data.entry.srs.stage).toBe(2);
    const entries = await getEntriesMap();
    expect(entries.e1.srs.stage).toBe(2);
    expect((await getStats(NOW)).reviewed).toBe(1);
  });

  it('评分不存在的词条返回 NOT_FOUND', async () => {
    const result = await handleMessage(
      { type: 'review:rate', payload: { id: 'nope', rating: 'known' } },
      NOW,
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
  });
});

describe('words 与 settings', () => {
  it('更新设置时深合并并保留其余字段', async () => {
    const first = await handleMessage(
      { type: 'settings:update', payload: { provider: { mode: 'ai' } } },
      NOW,
    );
    expect(first.ok).toBe(true);
    const second = await handleMessage(
      { type: 'settings:update', payload: { review: { intervalSec: 60 } } },
      NOW,
    );
    expect(second.ok).toBe(true);
    const settings = (second as { data: Settings }).data;
    expect(settings.provider.mode).toBe('ai');
    expect(settings.review.intervalSec).toBe(60);
    expect((await getSettings()).provider.mode).toBe('ai');
  });

  it('settings:public 不包含 API Key', async () => {
    const result = await handleMessage({ type: 'settings:public', payload: {} }, NOW);
    const data = (result as { data: Record<string, any> }).data;
    expect(JSON.stringify(data)).not.toContain('apiKey');
  });

  it('删除词条', async () => {
    store[STORAGE_KEYS.entries] = {
      e1: {
        id: 'e1',
        text: 'x',
        kind: 'word',
        translation: 'x',
        createdAt: NOW,
        updatedAt: NOW,
        lookups: 1,
        srs: { stage: 0, dueAt: NOW, reps: 0, lapses: 0, knownStreak: 0 },
      },
    };
    const result = await handleMessage({ type: 'words:delete', payload: { id: 'e1' } }, NOW);
    expect(result.ok).toBe(true);
    expect(await getEntriesMap()).toEqual({});
  });

  it('words:list 支持搜索与排序', async () => {
    store[STORAGE_KEYS.entries] = {
      a: {
        id: 'a',
        text: 'apple',
        kind: 'word',
        translation: '苹果',
        createdAt: NOW,
        updatedAt: NOW,
        lookups: 3,
        srs: { stage: 0, dueAt: NOW, reps: 0, lapses: 0, knownStreak: 0 },
      },
      b: {
        id: 'b',
        text: 'banana',
        kind: 'word',
        translation: '香蕉',
        createdAt: NOW + 1,
        updatedAt: NOW + 1,
        lookups: 1,
        srs: { stage: 0, dueAt: NOW, reps: 0, lapses: 0, knownStreak: 0 },
      },
    };
    const result = await handleMessage(
      { type: 'words:list', payload: { query: 'apple', sort: 'lookups' } },
      NOW,
    );
    const data = (result as { data: Entry[] }).data;
    expect(data.map((entry) => entry.id)).toEqual(['a']);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/messages.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 shared/messages.ts 与 background/messages.ts**

`src/shared/messages.ts`:

```ts
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
```

`src/background/messages.ts`:

```ts
import { MAX_CONTEXT_LENGTH } from '../shared/constants';
import { ProviderError } from '../shared/http';
import type {
  Entry,
  ErrorCode,
  ExtMessage,
  LookupResponse,
  Result,
  Stats,
} from '../shared/types';
import {
  classifySelection,
  isValidSelection,
  normalizeText,
  sanitizeHttpUrl,
  truncate,
} from '../shared/utils';
import { resolveLookup } from './providers';
import { pickNext, rateEntry } from './srs';
import {
  buildExport,
  bumpStat,
  clearEntries,
  deleteEntry,
  getEntriesMap,
  getEntry,
  getPublicSettings,
  getSettings,
  getStats,
  importEntries,
  listEntries,
  saveEntry,
  updateSettings,
  upsertLookup,
} from './storage';
import { aiLookup, freeLookup } from './providers';

function ok<T>(data: T): Result<T> {
  return { ok: true, data };
}

function fail(code: ErrorCode, message: string): Result<never> {
  return { ok: false, error: { code, message } };
}

function errorToResult(error: unknown): Result<never> {
  if (error instanceof ProviderError) return fail(error.code, error.message);
  return fail('NETWORK', '操作失败，请稍后重试');
}

export async function handleMessage(
  message: ExtMessage,
  now = Date.now(),
): Promise<Result<unknown>> {
  try {
    switch (message.type) {
      case 'lookup': {
        const text = normalizeText(message.payload.text);
        if (!isValidSelection(text)) {
          return fail('INVALID_PAYLOAD', '选中内容为空或过长');
        }
        const context = message.payload.context
          ? truncate(normalizeText(message.payload.context), MAX_CONTEXT_LENGTH)
          : undefined;
        const settings = await getSettings();
        const outcome = await resolveLookup(text, context, settings);
        const sourceTitle = message.payload.sourceTitle
          ? truncate(message.payload.sourceTitle, 200)
          : undefined;
        const { entry, created } = await upsertLookup(
          {
            id: crypto.randomUUID(),
            text,
            kind: classifySelection(text),
            payload: outcome.payload,
            context,
            sourceUrl: sanitizeHttpUrl(message.payload.sourceUrl),
            sourceTitle,
          },
          now,
        );
        if (created) await bumpStat('added', now);
        const response: LookupResponse = {
          entry,
          provider: outcome.provider,
          cached: outcome.cached,
          fallbackReason: outcome.fallbackReason,
        };
        return ok(response);
      }

      case 'review:next': {
        const settings = await getSettings();
        if (!settings.review.enabled) return ok(null);
        if (settings.review.pausedHosts.includes(message.payload.host)) return ok(null);
        const entries = Object.values(await getEntriesMap());
        const entry = pickNext(entries, now, message.payload.recentIds);
        if (!entry) return ok(null);
        await bumpStat('shown', now);
        return ok(entry);
      }

      case 'review:rate': {
        const entry = await getEntry(message.payload.id);
        if (!entry) return fail('NOT_FOUND', '词条不存在');
        if (!['known', 'unsure', 'unknown'].includes(message.payload.rating)) {
          return fail('INVALID_PAYLOAD', '评分无效');
        }
        const updated = rateEntry(entry, message.payload.rating, now);
        await saveEntry(updated);
        await bumpStat('reviewed', now);
        return ok({ entry: updated, dueAt: updated.srs.dueAt });
      }

      case 'words:list': {
        return ok(await listEntries(message.payload, now));
      }

      case 'words:update': {
        const entry = await getEntry(message.payload.id);
        if (!entry) return fail('NOT_FOUND', '词条不存在');
        const note = message.payload.patch.note;
        if (note !== undefined && note.length > 1000) {
          return fail('INVALID_PAYLOAD', '备注过长');
        }
        const updated: Entry = {
          ...entry,
          note: note !== undefined ? note : entry.note,
          translation: message.payload.patch.translation?.trim() || entry.translation,
          updatedAt: now,
        };
        await saveEntry(updated);
        return ok(updated);
      }

      case 'words:delete': {
        const deleted = await deleteEntry(message.payload.id);
        return deleted ? ok({ deleted: true }) : fail('NOT_FOUND', '词条不存在');
      }

      case 'words:clear': {
        await clearEntries();
        return ok({ cleared: true });
      }

      case 'words:import': {
        if (!Array.isArray(message.payload.entries)) {
          return fail('INVALID_PAYLOAD', '导入数据格式错误');
        }
        return ok(await importEntries(message.payload.entries, message.payload.mode));
      }

      case 'words:export': {
        return ok(await buildExport(now));
      }

      case 'settings:get': {
        return ok(await getSettings());
      }

      case 'settings:public': {
        return ok(await getPublicSettings());
      }

      case 'settings:update': {
        return ok(await updateSettings(message.payload));
      }

      case 'stats:get': {
        const stats: Stats = await getStats(now);
        return ok(stats);
      }

      case 'provider:test': {
        const settings = await getSettings();
        if (settings.provider.mode === 'ai') {
          const payload = await aiLookup('hello', 'word', undefined, settings.provider.ai);
          return ok({ provider: 'ai', sample: payload.translation });
        }
        const payload = await freeLookup('hello', 'word');
        return ok({ provider: 'free', sample: payload.translation });
      }

      default:
        return fail('UNKNOWN_MESSAGE', '未知消息类型');
    }
  } catch (error) {
    return errorToResult(error);
  }
}
```

> 注意：`default` 分支用于运行期未知类型；`ExtMessage` 已穷尽时 TS 可能判定 `never`，若报错则把 `default` 改为 `case` 之外的兜底函数 `unreachable`，保持返回 `UNKNOWN_MESSAGE`。

- [ ] **Step 4: 实现 background/index.ts**

`src/background/index.ts`:

```ts
import { handleMessage } from './messages';
import { ensureSchema } from './storage';
import { isExtMessage } from '../shared/messages';
import type { Result, ReviewMode } from '../shared/types';

void ensureSchema();

async function previewActiveTab(mode: ReviewMode): Promise<Result<{ shown: boolean }>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
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
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/messages.test.ts`
Expected: 全部 PASS。

- [ ] **Step 6: 类型检查并提交**

Run: `npm run typecheck`
Expected: 无错误（如遇 `default` 分支的 `never` 报错，按 Step 3 备注处理）。

```bash
git add src/shared/messages.ts src/background/messages.ts src/background/index.ts tests/messages.test.ts
git commit -m "feat: add typed message protocol and background handlers"
```

---

### Task 7: Content 基础设施与划词查词

**Files:**
- Create: `src/content/shadowHost.ts`, `src/content/uiState.ts`
- Create: `src/content/selection/position.ts`, `src/content/selection/LookupCard.tsx`, `src/content/selection/SelectionLayer.tsx`
- Create: `src/shared/styles/content.css`
- Modify: `src/content/index.tsx`
- Test: `tests/position.test.ts`

**Interfaces:**
- Consumes: `sendToBackground`、`LookupResponse`、`Entry`、`extractContext`、`normalizeText`、`isValidSelection`
- Produces:
  - `createShadowHost(id: string, cssText: string, zIndex: number): { host: HTMLDivElement; root: HTMLDivElement }`
  - `uiState: { cardOpen: boolean; overlayOpen: boolean }`
  - `computeCardPosition(anchor: Rect, viewport: { width: number; height: number }, size: { width: number; height: number }): { top: number; left: number; placement: 'above' | 'below' }`
  - `SelectionLayer`、`LookupCard` React 组件

- [ ] **Step 1: 写失败的定位测试**

`tests/position.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { computeCardPosition } from '../src/content/selection/position';

const viewport = { width: 1000, height: 800 };
const size = { width: 320, height: 220 };

describe('computeCardPosition', () => {
  it('空间足够时放在选区下方', () => {
    const pos = computeCardPosition({ top: 100, bottom: 120, left: 200, right: 300 }, viewport, size);
    expect(pos.placement).toBe('below');
    expect(pos.top).toBe(128);
    expect(pos.left).toBe(200);
  });

  it('下方空间不足时翻转到上方', () => {
    const pos = computeCardPosition({ top: 700, bottom: 720, left: 200, right: 300 }, viewport, size);
    expect(pos.placement).toBe('above');
    expect(pos.top).toBe(700 - 8 - size.height);
  });

  it('左右越界时向内收', () => {
    const pos = computeCardPosition({ top: 100, bottom: 120, left: 950, right: 990 }, viewport, size);
    expect(pos.left).toBe(1000 - size.width - 8);
  });

  it('上下都放不下时贴底', () => {
    const pos = computeCardPosition({ top: 200, bottom: 700, left: 100, right: 200 }, viewport, size);
    expect(pos.top).toBe(800 - size.height - 8);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/position.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 position、shadowHost、uiState**

`src/content/selection/position.ts`:

```ts
export interface Rect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface CardPosition {
  top: number;
  left: number;
  placement: 'above' | 'below';
}

export function computeCardPosition(
  anchor: Rect,
  viewport: Viewport,
  size: Size,
): CardPosition {
  const gap = 8;
  const margin = 8;
  const left = Math.min(
    Math.max(margin, anchor.left),
    Math.max(margin, viewport.width - size.width - margin),
  );
  const below = anchor.bottom + gap;
  const above = anchor.top - gap - size.height;

  if (below + size.height <= viewport.height - margin) {
    return { top: below, left, placement: 'below' };
  }
  if (above >= margin) {
    return { top: above, left, placement: 'above' };
  }
  return {
    top: Math.max(margin, viewport.height - size.height - margin),
    left,
    placement: 'above',
  };
}
```

`src/content/shadowHost.ts`:

```ts
export interface ShadowHost {
  host: HTMLDivElement;
  root: HTMLDivElement;
}

export function createShadowHost(id: string, cssText: string, zIndex: number): ShadowHost {
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
  root.className = 'ww-root';
  shadow.appendChild(root);
  document.documentElement.appendChild(host);
  return { host, root };
}
```

`src/content/uiState.ts`:

```ts
export const uiState = {
  cardOpen: false,
  overlayOpen: false,
};
```

- [ ] **Step 4: 实现 LookupCard 与 SelectionLayer**

`src/content/selection/LookupCard.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { sendToBackground } from '../../shared/messages';
import type { ErrorCode, LookupResponse } from '../../shared/types';
import { computeCardPosition, type Rect } from './position';

export interface CardRequest {
  text: string;
  anchor: Rect;
  context: string;
  sourceUrl: string;
  sourceTitle: string;
}

type CardState =
  | { status: 'loading' }
  | { status: 'ready'; data: LookupResponse }
  | { status: 'error'; message: string; code: ErrorCode };

export function LookupCard({
  request,
  onClose,
}: {
  request: CardRequest;
  onClose: () => void;
}) {
  const [state, setState] = useState<CardState>({ status: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [size] = useState({ width: 320, height: 220 });
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    setState({ status: 'loading' });
    (async () => {
      const result = await sendToBackground<LookupResponse>({
        type: 'lookup',
        payload: {
          text: request.text,
          context: request.context,
          sourceUrl: request.sourceUrl,
          sourceTitle: request.sourceTitle,
        },
      });
      if (!alive) return;
      setState(
        result.ok
          ? { status: 'ready', data: result.data }
          : { status: 'error', message: result.error.message, code: result.error.code },
      );
    })();
    return () => {
      alive = false;
    };
  }, [request.text, request.context, request.sourceUrl, request.sourceTitle, attempt]);

  const position = computeCardPosition(
    request.anchor,
    { width: window.innerWidth, height: window.innerHeight },
    { width: size.width, height: ref.current?.offsetHeight ?? size.height },
  );

  const speak = (text: string) => {
    if (!('speechSynthesis' in window)) return;
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'en-US';
    window.speechSynthesis.speak(utterance);
  };

  const remove = async () => {
    if (state.status !== 'ready') return;
    await sendToBackground({ type: 'words:delete', payload: { id: state.data.entry.id } });
    onClose();
  };

  return (
    <div
      ref={ref}
      className="ww-card"
      style={{ top: position.top, left: position.left }}
      role="dialog"
      aria-label="查词结果"
    >
      {state.status === 'loading' && (
        <div className="ww-card-loading">
          <div className="ww-skeleton ww-skeleton-wide" />
          <div className="ww-skeleton" />
          <div className="ww-skeleton ww-skeleton-short" />
        </div>
      )}

      {state.status === 'error' && (
        <div className="ww-card-error">
          <div className="ww-error-title">查询失败</div>
          <p>{state.message}</p>
          <div className="ww-card-actions">
            <button className="ww-btn" onClick={() => setAttempt((value) => value + 1)}>
              重试
            </button>
            {state.code === 'CONFIG' && (
              <button className="ww-btn ww-btn-primary" onClick={() => chrome.runtime.openOptionsPage()}>
                去设置里配置 AI
              </button>
            )}
            <button className="ww-btn" onClick={onClose}>
              关闭
            </button>
          </div>
        </div>
      )}

      {state.status === 'ready' && (
        <>
          <div className="ww-card-head">
            <div className="ww-word-row">
              <strong className="ww-word">{state.data.entry.text}</strong>
              {state.data.entry.phonetic && (
                <span className="ww-phonetic">{state.data.entry.phonetic}</span>
              )}
              {state.data.entry.kind === 'word' && (
                <button
                  className="ww-icon-btn"
                  title="发音"
                  onClick={() => speak(state.data.entry.text)}
                >
                  🔊
                </button>
              )}
            </div>
            <button className="ww-icon-btn" title="关闭" onClick={onClose}>
              ✕
            </button>
          </div>

          <div className="ww-meta-line">
            {state.data.entry.lookups > 1 && <span>已收录 · 第 {state.data.entry.lookups} 次查询</span>}
            {state.data.cached && <span>离线缓存</span>}
            {state.data.fallbackReason === 'ai-unconfigured' && (
              <button className="ww-link" onClick={() => chrome.runtime.openOptionsPage()}>
                AI 未配置，已用免费接口
              </button>
            )}
            {state.data.fallbackReason === 'ai-error' && <span>AI 失败，已回退免费接口</span>}
          </div>

          {state.data.entry.senses?.length ? (
            <ul className="ww-senses">
              {state.data.entry.senses.map((sense, index) => (
                <li key={index}>
                  {sense.pos && <span className="ww-pos">{sense.pos}</span>}
                  {sense.def}
                </li>
              ))}
            </ul>
          ) : null}

          {state.data.entry.example && (
            <p className="ww-example">{state.data.entry.example}</p>
          )}

          {state.data.entry.translation && (
            <div className="ww-translation">{state.data.entry.translation}</div>
          )}

          <div className="ww-card-actions">
            <button
              className="ww-btn"
              onClick={() => {
                void navigator.clipboard
                  .writeText(state.data.entry.translation || state.data.entry.text)
                  .catch(() => undefined);
              }}
            >
              复制
            </button>
            <button className="ww-btn ww-btn-danger" onClick={remove}>
              移出生词本
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

`src/content/selection/SelectionLayer.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { extractContext, isValidSelection, normalizeText } from '../../shared/utils';
import { uiState } from '../uiState';
import { LookupCard, type CardRequest } from './LookupCard';
import type { Rect } from './position';

interface TriggerState extends CardRequest {
  key: number;
}

function isInsideExtension(event: Event): boolean {
  return event
    .composedPath()
    .some((node) => (node as HTMLElement)?.dataset?.wwUi === '1');
}

export function SelectionLayer() {
  const [trigger, setTrigger] = useState<Omit<TriggerState, 'key'> | null>(null);
  const [card, setCard] = useState<TriggerState | null>(null);
  const cardRef = useRef<TriggerState | null>(null);
  cardRef.current = card;

  const closeCard = useCallback(() => {
    setCard(null);
    uiState.cardOpen = false;
  }, []);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const onMouseUp = (event: MouseEvent) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (cardRef.current) return;
        if (isInsideExtension(event)) return;

        const selection = window.getSelection();
        const rawText = selection?.toString() ?? '';
        if (!selection || selection.rangeCount === 0 || !isValidSelection(rawText)) {
          setTrigger(null);
          return;
        }

        const anchorNode = selection.anchorNode;
        const element =
          anchorNode?.nodeType === Node.ELEMENT_NODE
            ? (anchorNode as Element)
            : anchorNode?.parentElement ?? null;
        if (
          element?.closest(
            'input, textarea, [contenteditable=""], [contenteditable="true"]',
          )
        ) {
          setTrigger(null);
          return;
        }

        const rect = selection.getRangeAt(0).getBoundingClientRect();
        const block = element?.closest('p, li, article, section, blockquote, div');
        const text = normalizeText(rawText);
        const anchor: Rect = {
          top: rect.top,
          bottom: rect.bottom,
          left: rect.left,
          right: rect.right,
        };
        setTrigger({
          text,
          anchor,
          context: extractContext(block?.textContent ?? '', text),
          sourceUrl: location.href,
          sourceTitle: document.title,
        });
      }, 150);
    };

    const onMouseDown = (event: MouseEvent) => {
      if (isInsideExtension(event)) return;
      setTrigger(null);
      closeCard();
    };

    const onSelectionChange = () => {
      const selection = window.getSelection();
      if ((!selection || selection.isCollapsed) && !cardRef.current) setTrigger(null);
    };

    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, [closeCard]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setTrigger(null);
        closeCard();
      }
    };
    const onScroll = (event: Event) => {
      if (isInsideExtension(event)) return;
      setTrigger(null);
      closeCard();
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [closeCard]);

  const openCard = () => {
    if (!trigger) return;
    setCard({ ...trigger, key: Date.now() });
    setTrigger(null);
    uiState.cardOpen = true;
  };

  return (
    <>
      {trigger && (
        <button
          className="ww-trigger"
          style={{
            left: Math.min(trigger.anchor.right + 6, window.innerWidth - 32),
            top: Math.min(trigger.anchor.bottom + 6, window.innerHeight - 32),
          }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={openCard}
          title="查词 / 翻译"
        >
          译
        </button>
      )}
      {card && <LookupCard key={card.key} request={card} onClose={closeCard} />}
    </>
  );
}
```

- [ ] **Step 5: 写 content.css（划词部分）**

`src/shared/styles/content.css`:

```css
:host {
  all: initial;
}

* {
  box-sizing: border-box;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC',
    'Microsoft YaHei', sans-serif;
}

.ww-trigger {
  position: fixed;
  width: 26px;
  height: 26px;
  border: 0;
  border-radius: 50%;
  background: #0d9488;
  color: #fff;
  font-size: 12px;
  line-height: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
  pointer-events: auto;
  z-index: 2;
  user-select: none;
}

.ww-card {
  position: fixed;
  width: 320px;
  max-height: 60vh;
  overflow: auto;
  background: #ffffff;
  color: #1f2937;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.2);
  padding: 12px 14px;
  font-size: 13px;
  line-height: 1.55;
  pointer-events: auto;
  z-index: 3;
}

.ww-card-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}

.ww-word-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.ww-word {
  font-size: 18px;
  color: #0f172a;
}

.ww-phonetic {
  color: #64748b;
  font-size: 12px;
}

.ww-icon-btn {
  border: 0;
  background: transparent;
  color: #64748b;
  cursor: pointer;
  font-size: 13px;
  padding: 2px;
}

.ww-icon-btn:hover {
  color: #0f172a;
}

.ww-meta-line {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: #0d9488;
  font-size: 12px;
  margin: 6px 0;
}

.ww-link {
  border: 0;
  background: transparent;
  color: #0d9488;
  text-decoration: underline;
  cursor: pointer;
  padding: 0;
  font-size: 12px;
}

.ww-senses {
  margin: 8px 0;
  padding-left: 18px;
  color: #334155;
}

.ww-senses li {
  margin-bottom: 4px;
}

.ww-pos {
  color: #0d9488;
  margin-right: 6px;
  font-style: italic;
}

.ww-example {
  margin: 8px 0;
  padding: 8px 10px;
  background: #f1f5f9;
  border-radius: 6px;
  color: #475569;
  font-style: italic;
}

.ww-translation {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid #e2e8f0;
  color: #0f172a;
}

.ww-card-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.ww-btn {
  border: 1px solid #cbd5e1;
  background: #f8fafc;
  color: #334155;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 12px;
  cursor: pointer;
}

.ww-btn:hover {
  background: #f1f5f9;
}

.ww-btn-primary {
  background: #0d9488;
  border-color: #0d9488;
  color: #fff;
}

.ww-btn-danger {
  border-color: #fecaca;
  color: #b91c1c;
  background: #fef2f2;
}

.ww-card-error p {
  margin: 6px 0;
  color: #475569;
}

.ww-error-title {
  color: #b91c1c;
  font-weight: 600;
}

.ww-skeleton {
  height: 12px;
  border-radius: 4px;
  background: #e2e8f0;
  margin-bottom: 8px;
  animation: ww-pulse 1.2s ease-in-out infinite;
}

.ww-skeleton-wide {
  width: 80%;
  height: 18px;
}

.ww-skeleton-short {
  width: 50%;
}

@keyframes ww-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.45; }
}
```

- [ ] **Step 6: 更新 content/index.tsx**

`src/content/index.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import css from '../shared/styles/content.css?inline';
import { createShadowHost } from './shadowHost';
import { SelectionLayer } from './selection/SelectionLayer';

const selectionHost = createShadowHost('ww-selection-host', css, 2147483647);
createRoot(selectionHost.root).render(<SelectionLayer />);
```

- [ ] **Step 7: 运行定位测试与构建**

Run: `npx vitest run tests/position.test.ts`
Expected: 全部 PASS。

Run: `npm run build`
Expected: 构建成功，`dist/content.js` 生成。

- [ ] **Step 8: 手动验证划词**

1. 打开 `chrome://extensions` → 开发模式 → 加载已解压的扩展程序 → 选择 `dist/`。
2. 打开任意英文网页，选中一个单词 → 出现「译」图标 → 点击。
3. Expected: 卡片显示音标/释义/例句/中文译义；`chrome.storage.local`（SW 控制台 `chrome.storage.local.get('ww.entries.v1')`）中出现该词。
4. 选中一整句 → 卡片显示译文；选中输入框内文字不出现图标。

- [ ] **Step 9: 提交**

```bash
git add src/content src/shared/styles/content.css tests/position.test.ts
git commit -m "feat: add selection trigger and lookup card in isolated shadow DOM"
```

---

### Task 8: 复习调度与三种浮层形态

**Files:**
- Create: `src/content/scheduler.ts`, `src/content/review/skip.ts`, `src/content/review/preview.ts`, `src/content/review/sample.ts`
- Create: `src/content/review/Overlay.tsx`, `src/content/review/RatingButtons.tsx`, `src/content/review/SubtitleMode.tsx`, `src/content/review/BarrageMode.tsx`, `src/content/review/CardMode.tsx`, `src/content/review/ReviewHost.tsx`
- Modify: `src/content/index.tsx`, `src/shared/styles/content.css`
- Test: `tests/scheduler.test.ts`

**Interfaces:**
- Consumes: Task 7 的 `createShadowHost`/`uiState`；`sendToBackground`、`PublicSettings`、`Entry`、`formatNextReview`、`STORAGE_KEYS`、`RECENT_SHOWN_LIMIT`
- Produces:
  - `jitter(intervalSec: number, random?: () => number): number`
  - `startScheduler(config: { intervalSec: number; shouldSkip: () => boolean; onFire: () => Promise<boolean>; random?: () => number }): () => void`
  - `onPreview(handler: (mode: ReviewMode) => void): () => void`
  - `emitPreview(mode: ReviewMode): void`
  - `ReviewHost` React 组件

- [ ] **Step 1: 写失败的调度器测试**

`tests/scheduler.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { jitter, startScheduler } from '../src/content/scheduler';

describe('jitter', () => {
  it('随机数 0.5 时不抖动', () => {
    expect(jitter(60, () => 0.5)).toBe(60_000);
  });

  it('浮动范围在 ±20% 内', () => {
    expect(jitter(60, () => 0)).toBe(48_000);
    expect(jitter(60, () => 1)).toBe(72_000);
  });

  it('不低于 1 秒', () => {
    expect(jitter(1, () => 0)).toBe(1000);
  });
});

describe('startScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('到期后触发 onFire', async () => {
    const onFire = vi.fn(async () => true);
    const stop = startScheduler({
      intervalSec: 60,
      shouldSkip: () => false,
      onFire,
      random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onFire).toHaveBeenCalledTimes(1);
    stop();
  });

  it('跳过条件成立时延迟重试且不触发', async () => {
    const onFire = vi.fn(async () => true);
    const stop = startScheduler({
      intervalSec: 60,
      shouldSkip: () => true,
      onFire,
      random: () => 0.5,
    });
    await vi.advanceTimersByTimeAsync(61_000);
    expect(onFire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(onFire).not.toHaveBeenCalled();
    stop();
  });

  it('stop 后不再触发', async () => {
    const onFire = vi.fn(async () => true);
    const stop = startScheduler({
      intervalSec: 60,
      shouldSkip: () => false,
      onFire,
      random: () => 0.5,
    });
    stop();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(onFire).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 scheduler、skip、preview、sample**

`src/content/scheduler.ts`:

```ts
import { SKIP_RETRY_MS } from '../shared/constants';

export interface SchedulerConfig {
  intervalSec: number;
  shouldSkip: () => boolean;
  onFire: () => Promise<boolean>;
  random?: () => number;
}

export function jitter(intervalSec: number, random: () => number = Math.random): number {
  const factor = 0.8 + random() * 0.4;
  return Math.max(1000, Math.round(intervalSec * 1000 * factor));
}

export function startScheduler(config: SchedulerConfig): () => void {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const schedule = (delay: number) => {
    if (stopped) return;
    clearTimeout(timer);
    timer = setTimeout(tick, delay);
  };

  const tick = async () => {
    if (stopped) return;
    if (config.shouldSkip()) {
      schedule(SKIP_RETRY_MS);
      return;
    }
    let shown = false;
    try {
      shown = await config.onFire();
    } catch {
      shown = false;
    }
    schedule(shown ? jitter(config.intervalSec, config.random) : SKIP_RETRY_MS);
  };

  schedule(jitter(config.intervalSec, config.random));
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
```

`src/content/review/skip.ts`:

```ts
export function shouldSkipPage(doc: Document = document): boolean {
  if (doc.hidden) return true;
  if (doc.fullscreenElement) return true;

  const active = doc.activeElement as HTMLElement | null;
  if (
    active &&
    (active.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName))
  ) {
    return true;
  }

  const selection = doc.defaultView?.getSelection();
  if (selection && !selection.isCollapsed && selection.toString().trim()) {
    return true;
  }
  return false;
}
```

`src/content/review/preview.ts`:

```ts
import type { ReviewMode } from '../../shared/types';

type PreviewHandler = (mode: ReviewMode) => void;
const handlers = new Set<PreviewHandler>();

export function onPreview(handler: PreviewHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function emitPreview(mode: ReviewMode): void {
  handlers.forEach((handler) => handler(mode));
}
```

`src/content/review/sample.ts`:

```ts
import type { Entry } from '../../shared/types';

export const PREVIEW_SAMPLE: Entry = {
  id: 'ww-preview',
  text: 'serendipity',
  kind: 'word',
  translation: '意外发现美好事物的运气',
  phonetic: '/ˌserənˈdɪpəti/',
  senses: [{ pos: 'n.', def: '意外发现珍奇事物的本领' }],
  example: 'Finding this cafe was pure serendipity.',
  createdAt: 0,
  updatedAt: 0,
  lookups: 1,
  srs: { stage: 0, dueAt: 0, reps: 0, lapses: 0, knownStreak: 0 },
};
```

- [ ] **Step 4: 实现三个形态与 Overlay**

`src/content/review/RatingButtons.tsx`:

```tsx
import type { Rating } from '../../shared/types';

export function RatingButtons({ onRate }: { onRate: (rating: Rating) => void }) {
  return (
    <div className="ww-rating">
      <button className="ww-rate ww-known" onClick={() => onRate('known')}>
        认识
      </button>
      <button className="ww-rate ww-unsure" onClick={() => onRate('unsure')}>
        模糊
      </button>
      <button className="ww-rate ww-unknown" onClick={() => onRate('unknown')}>
        不认识
      </button>
    </div>
  );
}
```

`src/content/review/SubtitleMode.tsx`:

```tsx
import type { Entry, Rating, ReviewPosition } from '../../shared/types';
import { RatingButtons } from './RatingButtons';

export function SubtitleMode({
  entry,
  position,
  expanded,
  durationSec,
  onRate,
}: {
  entry: Entry;
  position: ReviewPosition;
  expanded: boolean;
  durationSec: number;
  onRate: (rating: Rating) => void;
}) {
  return (
    <div className={`ww-subtitle ww-${position}`}>
      <div
        className="ww-progress"
        style={{
          animationDuration: `${durationSec}s`,
          animationPlayState: expanded ? 'paused' : 'running',
        }}
      />
      <div className="ww-subtitle-main">
        <strong>{entry.text}</strong>
        {entry.phonetic && <span className="ww-phonetic">{entry.phonetic}</span>}
        <span className="ww-subtitle-translation">{entry.translation}</span>
      </div>
      {expanded && (
        <div className="ww-subtitle-more">
          {entry.senses?.slice(0, 2).map((sense, index) => (
            <div key={index}>
              {sense.pos ? <span className="ww-pos">{sense.pos}</span> : null}
              {sense.def}
            </div>
          ))}
          {entry.example && <em>{entry.example}</em>}
          <RatingButtons onRate={onRate} />
        </div>
      )}
    </div>
  );
}
```

`src/content/review/BarrageMode.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Entry, Rating } from '../../shared/types';
import { RatingButtons } from './RatingButtons';

export function BarrageMode({
  entry,
  onRate,
  onPausedChange,
  onDone,
}: {
  entry: Entry;
  onRate: (rating: Rating) => void;
  onPausedChange: (paused: boolean) => void;
  onDone: () => void;
}) {
  const [paused, setPaused] = useState(false);
  const duration = Math.max(6, Math.min(18, entry.text.length * 0.3 + 6));

  useEffect(() => {
    onPausedChange(paused);
  }, [paused, onPausedChange]);

  return (
    <div
      className="ww-barrage"
      style={{
        animationDuration: `${duration}s`,
        animationPlayState: paused ? 'paused' : 'running',
      }}
      onClick={() => setPaused(true)}
      onAnimationEnd={onDone}
    >
      <strong>{entry.text}</strong>
      <span>{entry.translation}</span>
      {paused && (
        <div className="ww-barrage-actions" onClick={(event) => event.stopPropagation()}>
          <RatingButtons onRate={onRate} />
        </div>
      )}
    </div>
  );
}
```

`src/content/review/CardMode.tsx`:

```tsx
import type { Entry, Rating, ReviewPosition } from '../../shared/types';
import { RatingButtons } from './RatingButtons';

export function CardMode({
  entry,
  position,
  onRate,
  onClose,
}: {
  entry: Entry;
  position: ReviewPosition;
  onRate: (rating: Rating) => void;
  onClose: () => void;
}) {
  return (
    <div className={`ww-cardmode ww-${position}`}>
      <div className="ww-cardmode-head">
        <div>
          <strong className="ww-word">{entry.text}</strong>
          {entry.phonetic && <span className="ww-phonetic">{entry.phonetic}</span>}
        </div>
        <button className="ww-icon-btn" title="关闭" onClick={onClose}>
          ✕
        </button>
      </div>
      {entry.senses?.slice(0, 2).map((sense, index) => (
        <div key={index} className="ww-cardmode-sense">
          {sense.pos ? <span className="ww-pos">{sense.pos}</span> : null}
          {sense.def}
        </div>
      ))}
      {entry.example && <p className="ww-example">{entry.example}</p>}
      {entry.translation && <div className="ww-translation">{entry.translation}</div>}
      <RatingButtons onRate={onRate} />
    </div>
  );
}
```

`src/content/review/Overlay.tsx`:

```tsx
import { useEffect, useState } from 'react';
import type { Entry, Rating, ReviewMode, ReviewPosition } from '../../shared/types';
import { BarrageMode } from './BarrageMode';
import { CardMode } from './CardMode';
import { SubtitleMode } from './SubtitleMode';

export function Overlay({
  entry,
  mode,
  position,
  durationSec,
  ratingEnabled,
  onRate,
  onClose,
}: {
  entry: Entry;
  mode: ReviewMode;
  position: ReviewPosition;
  durationSec: number;
  ratingEnabled: boolean;
  onRate: (rating: Rating) => void;
  onClose: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (hovered || paused) return;
    const timer = setTimeout(onClose, durationSec * 1000);
    return () => clearTimeout(timer);
  }, [hovered, paused, durationSec, onClose]);

  return (
    <div
      className={`ww-overlay ww-overlay-${mode}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {mode === 'subtitle' && (
        <SubtitleMode
          entry={entry}
          position={position}
          expanded={hovered}
          durationSec={durationSec}
          onRate={ratingEnabled ? onRate : onClose}
        />
      )}
      {mode === 'barrage' && (
        <BarrageMode
          entry={entry}
          onRate={ratingEnabled ? onRate : onClose}
          onPausedChange={setPaused}
          onDone={onClose}
        />
      )}
      {mode === 'card' && (
        <CardMode
          entry={entry}
          position={position}
          onRate={ratingEnabled ? onRate : onClose}
          onClose={onClose}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 5: 实现 ReviewHost**

`src/content/review/ReviewHost.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { RECENT_SHOWN_LIMIT, STORAGE_KEYS } from '../../shared/constants';
import { sendToBackground } from '../../shared/messages';
import type {
  Entry,
  PublicSettings,
  Rating,
  ReviewMode,
} from '../../shared/types';
import { formatNextReview } from '../../shared/utils';
import { startScheduler } from '../scheduler';
import { uiState } from '../uiState';
import { Overlay } from './Overlay';
import { onPreview } from './preview';
import { PREVIEW_SAMPLE } from './sample';
import { shouldSkipPage } from './skip';

export function ReviewHost() {
  const [settings, setSettings] = useState<PublicSettings | null>(null);
  const [entry, setEntry] = useState<Entry | null>(null);
  const [previewMode, setPreviewMode] = useState<ReviewMode | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const recentRef = useRef<string[]>([]);
  const toastTimer = useRef<ReturnType<typeof setTimeout>>();

  const loadSettings = useCallback(async () => {
    const result = await sendToBackground<PublicSettings>({ type: 'settings:public', payload: {} });
    if (result.ok) setSettings(result.data);
  }, []);

  useEffect(() => {
    void loadSettings();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes[STORAGE_KEYS.settings]) void loadSettings();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [loadSettings]);

  const close = useCallback(() => {
    setEntry(null);
    setPreviewing(false);
    setPreviewMode(null);
    uiState.overlayOpen = false;
  }, []);

  const showToast = useCallback((text: string) => {
    setToast(text);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1500);
  }, []);

  useEffect(() => {
    return onPreview(async (mode) => {
      const result = await sendToBackground<Entry | null>({
        type: 'review:next',
        payload: { host: location.hostname, recentIds: [] },
      });
      setPreviewMode(mode);
      setPreviewing(true);
      setEntry(result.ok && result.data ? result.data : PREVIEW_SAMPLE);
      uiState.overlayOpen = true;
    });
  }, []);

  useEffect(() => {
    if (!settings) return;
    if (!settings.review.enabled || settings.review.pausedHosts.includes(location.hostname)) {
      setEntry(null);
      uiState.overlayOpen = false;
      return;
    }

    return startScheduler({
      intervalSec: settings.review.intervalSec,
      shouldSkip: () => shouldSkipPage() || uiState.cardOpen || uiState.overlayOpen,
      onFire: async () => {
        const result = await sendToBackground<Entry | null>({
          type: 'review:next',
          payload: { host: location.hostname, recentIds: recentRef.current },
        });
        if (!result.ok || !result.data) return false;
        recentRef.current = [result.data.id, ...recentRef.current].slice(0, RECENT_SHOWN_LIMIT);
        setEntry(result.data);
        uiState.overlayOpen = true;
        return true;
      },
    });
  }, [settings]);

  const rate = useCallback(
    async (rating: Rating) => {
      if (!entry) return;
      if (previewing) {
        close();
        return;
      }
      const result = await sendToBackground<{ entry: Entry; dueAt: number }>({
        type: 'review:rate',
        payload: { id: entry.id, rating },
      });
      if (result.ok) {
        showToast(`已记录 · ${formatNextReview(result.data.dueAt, Date.now())}`);
      } else {
        showToast('保存失败，请稍后重试');
      }
      close();
    },
    [entry, previewing, close, showToast],
  );

  const mode = previewMode ?? settings?.review.displayMode ?? 'subtitle';

  if (!settings) return null;

  return (
    <>
      {entry && (
        <Overlay
          entry={entry}
          mode={mode}
          position={settings.review.position}
          durationSec={settings.review.durationSec}
          ratingEnabled={!previewing}
          onRate={rate}
          onClose={close}
        />
      )}
      {toast && <div className="ww-toast">{toast}</div>}
    </>
  );
}
```

- [ ] **Step 6: 更新 content/index.tsx 挂载复习层并处理预览消息**

`src/content/index.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import css from '../shared/styles/content.css?inline';
import { createShadowHost } from './shadowHost';
import { SelectionLayer } from './selection/SelectionLayer';
import { ReviewHost } from './review/ReviewHost';
import { emitPreview } from './review/preview';

const selectionHost = createShadowHost('ww-selection-host', css, 2147483647);
const reviewHost = createShadowHost('ww-review-host', css, 2147483646);

createRoot(selectionHost.root).render(<SelectionLayer />);
createRoot(reviewHost.root).render(<ReviewHost />);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'content:preview') {
    emitPreview(message.payload.mode);
    sendResponse({ shown: true });
  }
});
```

- [ ] **Step 7: 追加浮层样式**

在 `src/shared/styles/content.css` 末尾追加：

```css
.ww-overlay {
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 1;
}

.ww-overlay > * {
  pointer-events: auto;
}

.ww-subtitle {
  position: fixed;
  left: 50%;
  transform: translateX(-50%);
  max-width: min(720px, 90vw);
  background: rgba(15, 23, 42, 0.92);
  color: #e2e8f0;
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 14px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.ww-subtitle.ww-bottom {
  bottom: 48px;
}

.ww-subtitle.ww-top {
  top: 48px;
}

.ww-progress {
  position: absolute;
  top: 0;
  left: 0;
  height: 3px;
  width: 100%;
  background: #2dd4bf;
  transform-origin: left;
  animation-name: ww-progress;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
}

@keyframes ww-progress {
  from { transform: scaleX(1); }
  to { transform: scaleX(0); }
}

.ww-subtitle-main {
  display: flex;
  align-items: baseline;
  gap: 8px;
  flex-wrap: wrap;
}

.ww-subtitle-main strong {
  color: #fff;
  font-size: 16px;
}

.ww-subtitle-translation {
  color: #cbd5e1;
}

.ww-subtitle-more {
  margin-top: 8px;
  padding-top: 8px;
  border-top: 1px solid rgba(148, 163, 184, 0.35);
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: #cbd5e1;
}

.ww-subtitle-more .ww-pos {
  color: #2dd4bf;
}

.ww-rating {
  display: flex;
  gap: 8px;
  margin-top: 8px;
}

.ww-rate {
  border: 0;
  border-radius: 6px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  color: #fff;
}

.ww-known {
  background: #059669;
}

.ww-unsure {
  background: #d97706;
}

.ww-unknown {
  background: #dc2626;
}

.ww-barrage {
  position: fixed;
  bottom: 88px;
  left: 100vw;
  display: inline-flex;
  align-items: center;
  gap: 10px;
  max-width: 70vw;
  background: rgba(15, 23, 42, 0.9);
  color: #e2e8f0;
  border-radius: 999px;
  padding: 8px 16px;
  font-size: 14px;
  white-space: nowrap;
  overflow: hidden;
  animation-name: ww-barrage-move;
  animation-timing-function: linear;
  animation-fill-mode: forwards;
  cursor: pointer;
}

.ww-barrage strong {
  color: #fff;
}

.ww-barrage-actions {
  display: flex;
  align-items: center;
}

@keyframes ww-barrage-move {
  from { transform: translateX(0); }
  to { transform: translateX(-120vw); }
}

.ww-cardmode {
  position: fixed;
  width: 300px;
  right: 20px;
  background: #fff;
  color: #1f2937;
  border-radius: 10px;
  padding: 12px 14px;
  font-size: 13px;
  box-shadow: 0 8px 28px rgba(15, 23, 42, 0.25);
}

.ww-cardmode.ww-bottom {
  bottom: 20px;
}

.ww-cardmode.ww-top {
  top: 20px;
}

.ww-cardmode-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 8px;
}

.ww-cardmode-sense {
  margin-top: 6px;
  color: #334155;
}

.ww-toast {
  position: fixed;
  left: 50%;
  bottom: 120px;
  transform: translateX(-50%);
  background: rgba(15, 23, 42, 0.92);
  color: #fff;
  border-radius: 999px;
  padding: 6px 14px;
  font-size: 12px;
  pointer-events: none;
}

@media (prefers-reduced-motion: reduce) {
  .ww-progress,
  .ww-skeleton {
    animation: none;
  }
}
```

- [ ] **Step 8: 运行测试与构建**

Run: `npx vitest run tests/scheduler.test.ts`
Expected: 全部 PASS。

Run: `npm run typecheck` && `npm run build`
Expected: 均成功。

- [ ] **Step 9: 手动验证复习浮层**

1. 重新加载扩展，在 SW DevTools 控制台执行：
   ```js
   chrome.storage.local.set({ 'ww.settings.v1': { provider: { mode: 'free', ai: { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o-mini' } }, review: { enabled: true, intervalSec: 60, displayMode: 'subtitle', position: 'bottom', durationSec: 8, pausedHosts: [] } } })
   ```
2. 打开网页，选中一个词并查询，等待约 48–72 秒。
   Expected: 底部出现字幕条；悬停展开例句与评分按钮；点击「认识」后提示「已记录 · 1 天后」。
3. 在 SW 控制台切换到 `barrage` 后刷新网页，等待浮层出现；点击后停留并出现评分按钮。
4. 切换为 `card`，确认右下角卡片与关闭按钮。
5. 使用预览：在 SW 控制台执行
   ```js
   chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => chrome.tabs.sendMessage(t.id, { type: 'content:preview', payload: { mode: 'subtitle' } }))
   ```
   Expected: 立即出现一条样本词条浮层，评分按钮不可用（点击关闭）。

- [ ] **Step 10: 提交**

```bash
git add src/content src/shared/styles/content.css tests/scheduler.test.ts
git commit -m "feat: add review scheduler and subtitle/barrage/card overlays"
```

---

### Task 9: popup 页面

**Files:**
- Create: `src/popup/App.tsx`, `src/popup/style.css`
- Modify: `src/popup/main.tsx`, `src/shared/styles/pages.css`
- Create: `src/shared/styles/pages.css`

**Interfaces:**
- Consumes: `sendToBackground`、`Stats`、`Entry`、`Settings`、`hostFromUrl`
- Produces: popup UI（复习开关、站点暂停、最近生词、统计、入口按钮）

- [ ] **Step 1: 实现 App 与样式**

`src/popup/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import '../shared/styles/pages.css';
import './style.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

`src/popup/App.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { sendToBackground } from '../shared/messages';
import type { Entry, Settings, Stats } from '../shared/types';
import { hostFromUrl } from '../shared/utils';

export function App() {
  const [stats, setStats] = useState<Stats | null>(null);
  const [words, setWords] = useState<Entry[]>([]);
  const [dueCount, setDueCount] = useState(0);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [host, setHost] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    const [statsResult, wordsResult, dueResult, settingsResult, tabs] = await Promise.all([
      sendToBackground<Stats>({ type: 'stats:get', payload: {} }),
      sendToBackground<Entry[]>({ type: 'words:list', payload: { sort: 'created' } }),
      sendToBackground<Entry[]>({ type: 'words:list', payload: { dueOnly: true } }),
      sendToBackground<Settings>({ type: 'settings:get', payload: {} }),
      chrome.tabs.query({ active: true, currentWindow: true }),
    ]);
    if (statsResult.ok) setStats(statsResult.data);
    if (wordsResult.ok) setWords(wordsResult.data.slice(0, 7));
    if (dueResult.ok) setDueCount(dueResult.data.length);
    if (settingsResult.ok) setSettings(settingsResult.data);
    setHost(hostFromUrl(tabs[0]?.url));
  }

  async function toggleReview(next: boolean) {
    const result = await sendToBackground<Settings>({
      type: 'settings:update',
      payload: { review: { enabled: next } },
    });
    if (result.ok) setSettings(result.data);
  }

  async function togglePauseSite(next: boolean) {
    if (!settings || !host) return;
    const pausedHosts = next
      ? Array.from(new Set([...settings.review.pausedHosts, host]))
      : settings.review.pausedHosts.filter((item) => item !== host);
    const result = await sendToBackground<Settings>({
      type: 'settings:update',
      payload: { review: { pausedHosts } },
    });
    if (result.ok) setSettings(result.data);
  }

  return (
    <div className="ww-popup">
      <header className="ww-popup-head">
        <h1>Word World</h1>
        <span className="ww-badge">{stats ? `待复习 ${dueCount}` : '…'}</span>
      </header>

      <div className="ww-stats">
        <div>
          <strong>{stats?.reviewed ?? 0}</strong>
          <span>今日已复习</span>
        </div>
        <div>
          <strong>{stats?.added ?? 0}</strong>
          <span>今日新增</span>
        </div>
      </div>

      <div className="ww-row">
        <span>复习浮层</span>
        <label className="ww-switch">
          <input
            type="checkbox"
            checked={settings?.review.enabled ?? false}
            onChange={(event) => void toggleReview(event.target.checked)}
          />
          <span />
        </label>
      </div>

      <div className="ww-row">
        <span title={host ?? ''}>{host ? `在本站暂停（${host}）` : '在本站暂停'}</span>
        <label className="ww-switch">
          <input
            type="checkbox"
            disabled={!host || !settings}
            checked={Boolean(host && settings?.review.pausedHosts.includes(host))}
            onChange={(event) => void togglePauseSite(event.target.checked)}
          />
          <span />
        </label>
      </div>

      <h2 className="ww-subhead">最近收录</h2>
      <ul className="ww-recent">
        {words.length === 0 && <li className="ww-empty">还没有收录，去网页上划词试试。</li>}
        {words.map((entry) => (
          <li key={entry.id}>
            <span className="ww-recent-word">{entry.text}</span>
            <span className="ww-recent-translation">{entry.translation}</span>
          </li>
        ))}
      </ul>

      <footer className="ww-popup-actions">
        <button
          className="ww-btn"
          onClick={() => void chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') })}
        >
          生词本
        </button>
        <button className="ww-btn" onClick={() => chrome.runtime.openOptionsPage()}>
          设置
        </button>
      </footer>
    </div>
  );
}
```

`src/shared/styles/pages.css`:

```css
:root {
  --ww-teal: #0d9488;
  --ww-text: #0f172a;
  --ww-muted: #64748b;
  --ww-border: #e2e8f0;
  --ww-bg: #f8fafc;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'PingFang SC',
    'Microsoft YaHei', sans-serif;
  color: var(--ww-text);
  background: #fff;
  font-size: 14px;
}

h1,
h2 {
  margin: 0;
}

button {
  font-family: inherit;
}

.ww-btn {
  border: 1px solid #cbd5e1;
  background: #f8fafc;
  color: #334155;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}

.ww-btn:hover {
  background: #f1f5f9;
}

.ww-btn-primary {
  background: var(--ww-teal);
  border-color: var(--ww-teal);
  color: #fff;
}

.ww-btn-danger {
  border-color: #fecaca;
  color: #b91c1c;
  background: #fef2f2;
}

.ww-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--ww-border);
}

.ww-switch {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
}

.ww-switch input {
  opacity: 0;
  width: 0;
  height: 0;
}

.ww-switch span {
  position: absolute;
  inset: 0;
  background: #cbd5e1;
  border-radius: 999px;
  transition: background 0.15s;
  cursor: pointer;
}

.ww-switch span::before {
  content: '';
  position: absolute;
  width: 16px;
  height: 16px;
  left: 2px;
  top: 2px;
  background: #fff;
  border-radius: 50%;
  transition: transform 0.15s;
}

.ww-switch input:checked + span {
  background: var(--ww-teal);
}

.ww-switch input:checked + span::before {
  transform: translateX(16px);
}

.ww-switch input:disabled + span {
  opacity: 0.5;
  cursor: not-allowed;
}
```

`src/popup/style.css`:

```css
body {
  width: 320px;
}

.ww-popup {
  padding: 14px 16px 16px;
}

.ww-popup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
}

.ww-popup-head h1 {
  font-size: 16px;
}

.ww-badge {
  background: #ccfbf1;
  color: #0f766e;
  border-radius: 999px;
  padding: 2px 10px;
  font-size: 12px;
}

.ww-stats {
  display: flex;
  gap: 10px;
  margin-bottom: 10px;
}

.ww-stats > div {
  flex: 1;
  background: var(--ww-bg);
  border-radius: 8px;
  padding: 8px 10px;
  display: flex;
  flex-direction: column;
}

.ww-stats strong {
  font-size: 18px;
}

.ww-stats span {
  color: var(--ww-muted);
  font-size: 11px;
}

.ww-subhead {
  font-size: 12px;
  color: var(--ww-muted);
  margin: 14px 0 6px;
  font-weight: 600;
}

.ww-recent {
  list-style: none;
  margin: 0;
  padding: 0;
}

.ww-recent li {
  display: flex;
  gap: 8px;
  align-items: baseline;
  padding: 5px 0;
  border-bottom: 1px dashed var(--ww-border);
  font-size: 13px;
}

.ww-recent-word {
  font-weight: 600;
}

.ww-recent-translation {
  color: var(--ww-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ww-empty {
  color: var(--ww-muted);
}

.ww-popup-actions {
  display: flex;
  gap: 8px;
  margin-top: 14px;
}

.ww-popup-actions .ww-btn {
  flex: 1;
}
```

- [ ] **Step 2: 构建与类型检查**

Run: `npm run typecheck` && `npm run build`
Expected: 均成功。

- [ ] **Step 3: 手动验证 popup**

重新加载扩展 → 点击工具栏图标。
Expected: 显示统计、两个开关、最近收录列表；在网页上打开 popup 时「本站暂停」可用，勾选后该站点不再弹浮层；「生词本」「设置」按钮能打开对应页面。

- [ ] **Step 4: 提交**

```bash
git add src/popup src/shared/styles/pages.css
git commit -m "feat: add popup with stats, toggles and recent words"
```

---

### Task 10: options 设置页

**Files:**
- Create: `src/options/App.tsx`, `src/options/style.css`, `src/shared/files.ts`
- Modify: `src/options/main.tsx`, `src/shared/styles/pages.css`

**Interfaces:**
- Consumes: `sendToBackground`、`Settings`、`ExportBundle`、`ReviewMode`、`DEFAULT_SETTINGS`
- Produces:
  - `downloadJson(filename: string, data: unknown): void`
  - `readJsonFile(file: File): Promise<unknown>`
  - 设置页全部控件（数据源、AI 配置、复习参数、暂停站点、导入导出、预览）

- [ ] **Step 1: 实现文件助手与设置页**

`src/shared/files.ts`:

```ts
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export async function readJsonFile(file: File): Promise<unknown> {
  const text = await file.text();
  return JSON.parse(text) as unknown;
}
```

`src/options/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import '../shared/styles/pages.css';
import './style.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

`src/options/App.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import { DEFAULT_SETTINGS } from '../shared/constants';
import { downloadJson, readJsonFile } from '../shared/files';
import { sendToBackground } from '../shared/messages';
import type { Entry, ExportBundle, ReviewMode, Settings, SettingsPatch } from '../shared/types';
import { localDateKey } from '../shared/utils';

const MODES: Array<{ value: ReviewMode; label: string; hint: string }> = [
  { value: 'subtitle', label: '字幕条', hint: '底部一行字幕，悬停展开' },
  { value: 'barrage', label: '弹幕', hint: '从右向左飘过，点击停住' },
  { value: 'card', label: '角落卡片', hint: '右下角卡片，信息最全' },
];

export function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [hostsText, setHostsText] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void (async () => {
      const result = await sendToBackground<Settings>({ type: 'settings:get', payload: {} });
      if (result.ok) {
        setSettings(result.data);
        setHostsText(result.data.review.pausedHosts.join('\n'));
      }
      setLoaded(true);
    })();
  }, []);

  async function save(patch: SettingsPatch) {
    const result = await sendToBackground<Settings>({ type: 'settings:update', payload: patch });
    if (result.ok) {
      setSettings(result.data);
      setMessage('已保存');
      setTimeout(() => setMessage(null), 1200);
    } else {
      setMessage(result.error.message);
    }
  }

  async function saveHosts() {
    const pausedHosts = hostsText
      .split('\n')
      .map((host) => host.trim())
      .filter(Boolean);
    await save({ review: { pausedHosts } });
  }

  async function testProvider() {
    setMessage('测试中…');
    const result = await sendToBackground<{ provider: string; sample: string }>({
      type: 'provider:test',
      payload: {},
    });
    setMessage(
      result.ok ? `连接成功（${result.data.provider}）：${result.data.sample}` : result.error.message,
    );
  }

  async function exportData() {
    const result = await sendToBackground<ExportBundle>({ type: 'words:export', payload: {} });
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    downloadJson(`word-world-${localDateKey(Date.now())}.json`, result.data);
  }

  async function importData(file: File) {
    try {
      const raw = await readJsonFile(file);
      const entries = Array.isArray((raw as { entries?: unknown })?.entries)
        ? ((raw as { entries: Entry[] }).entries)
        : null;
      if (!entries) {
        setMessage('文件格式不正确：缺少 entries');
        return;
      }
      const result = await sendToBackground<{ imported: number; skipped: number }>({
        type: 'words:import',
        payload: { entries, mode: 'merge' },
      });
      setMessage(
        result.ok ? `导入完成：成功 ${result.data.imported}，跳过 ${result.data.skipped}` : result.error.message,
      );
    } catch {
      setMessage('JSON 解析失败');
    }
  }

  async function clearAll() {
    if (!window.confirm('确定清空全部生词？此操作不可撤销，建议先导出。')) return;
    const result = await sendToBackground({ type: 'words:clear', payload: {} });
    setMessage(result.ok ? '已清空' : '清空失败');
  }

  async function preview() {
    const result = await sendToBackground<{ shown: boolean }>({
      type: 'review:preview',
      payload: { mode: settings.review.displayMode },
    });
    setMessage(result.ok ? '已发送预览到当前网页' : result.error.message);
  }

  if (!loaded) return <div className="ww-page">加载中…</div>;

  return (
    <div className="ww-page">
      <h1>Word World 设置</h1>
      {message && <div className="ww-message">{message}</div>}

      <section>
        <h2>数据源</h2>
        <div className="ww-field">
          <label>
            <input
              type="radio"
              checked={settings.provider.mode === 'free'}
              onChange={() => void save({ provider: { mode: 'free' } })}
            />
            免费接口（dictionaryapi + Google/MyMemory）
          </label>
        </div>
        <div className="ww-field">
          <label>
            <input
              type="radio"
              checked={settings.provider.mode === 'ai'}
              onChange={() => void save({ provider: { mode: 'ai' } })}
            />
            AI（OpenAI 兼容接口）
          </label>
        </div>

        <div className="ww-grid">
          <label>
            Base URL
            <input
              value={settings.provider.ai.baseUrl}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  provider: { ...settings.provider, ai: { ...settings.provider.ai, baseUrl: event.target.value } },
                })
              }
            />
          </label>
          <label>
            API Key
            <input
              type="password"
              value={settings.provider.ai.apiKey}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  provider: { ...settings.provider, ai: { ...settings.provider.ai, apiKey: event.target.value } },
                })
              }
            />
          </label>
          <label>
            模型
            <input
              value={settings.provider.ai.model}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  provider: { ...settings.provider, ai: { ...settings.provider.ai, model: event.target.value } },
                })
              }
            />
          </label>
        </div>
        <div className="ww-actions">
          <button
            className="ww-btn ww-btn-primary"
            onClick={() => void save({ provider: { ai: settings.provider.ai } })}
          >
            保存 AI 配置
          </button>
          <button className="ww-btn" onClick={() => void testProvider()}>
            测试连接
          </button>
        </div>
      </section>

      <section>
        <h2>复习</h2>
        <div className="ww-field ww-inline">
          <label>
            <input
              type="checkbox"
              checked={settings.review.enabled}
              onChange={(event) => void save({ review: { enabled: event.target.checked } })}
            />
            启用网页复习浮层
          </label>
        </div>
        <div className="ww-field">
          <label>
            弹窗间隔：{settings.review.intervalSec} 秒
            <input
              type="range"
              min={60}
              max={1800}
              step={30}
              value={settings.review.intervalSec}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  review: { ...settings.review, intervalSec: Number(event.target.value) },
                })
              }
              onMouseUp={() => void save({ review: { intervalSec: settings.review.intervalSec } })}
              onTouchEnd={() => void save({ review: { intervalSec: settings.review.intervalSec } })}
            />
          </label>
        </div>
        <div className="ww-field">
          <span>浮层形态</span>
          <div className="ww-modes">
            {MODES.map((item) => (
              <button
                key={item.value}
                className={`ww-mode ${settings.review.displayMode === item.value ? 'ww-mode-active' : ''}`}
                onClick={() => void save({ review: { displayMode: item.value } })}
              >
                <strong>{item.label}</strong>
                <small>{item.hint}</small>
              </button>
            ))}
          </div>
        </div>
        <div className="ww-field ww-inline">
          <label>
            位置
            <select
              value={settings.review.position}
              onChange={(event) =>
                void save({ review: { position: event.target.value === 'top' ? 'top' : 'bottom' } })
              }
            >
              <option value="bottom">底部</option>
              <option value="top">顶部</option>
            </select>
          </label>
          <label>
            停留时长：{settings.review.durationSec} 秒
            <input
              type="range"
              min={4}
              max={30}
              value={settings.review.durationSec}
              onChange={(event) =>
                setSettings({
                  ...settings,
                  review: { ...settings.review, durationSec: Number(event.target.value) },
                })
              }
              onMouseUp={() => void save({ review: { durationSec: settings.review.durationSec } })}
              onTouchEnd={() => void save({ review: { durationSec: settings.review.durationSec } })}
            />
          </label>
        </div>
        <div className="ww-actions">
          <button className="ww-btn" onClick={() => void preview()}>
            立即预览一次浮层
          </button>
        </div>
      </section>

      <section>
        <h2>暂停复习的站点</h2>
        <p className="ww-hint">每行一个域名，例如 news.ycombinator.com</p>
        <textarea
          rows={4}
          value={hostsText}
          onChange={(event) => setHostsText(event.target.value)}
          onBlur={() => void saveHosts()}
        />
      </section>

      <section>
        <h2>数据</h2>
        <div className="ww-actions">
          <button className="ww-btn" onClick={() => void exportData()}>
            导出 JSON
          </button>
          <button className="ww-btn" onClick={() => fileRef.current?.click()}>
            导入 JSON
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importData(file);
              event.target.value = '';
            }}
          />
          <button className="ww-btn ww-btn-danger" onClick={() => void clearAll()}>
            清空全部
          </button>
        </div>
      </section>
    </div>
  );
}
```

- [ ] **Step 2: 写 options 样式**

`src/options/style.css`:

```css
.ww-page {
  max-width: 720px;
  margin: 0 auto;
  padding: 24px 20px 48px;
}

.ww-page h1 {
  font-size: 20px;
  margin-bottom: 16px;
}

.ww-page h2 {
  font-size: 15px;
  margin-bottom: 10px;
}

.ww-page section {
  border: 1px solid var(--ww-border);
  border-radius: 10px;
  padding: 16px;
  margin-bottom: 16px;
}

.ww-field {
  margin-bottom: 10px;
}

.ww-inline {
  display: flex;
  gap: 20px;
  flex-wrap: wrap;
}

.ww-grid {
  display: grid;
  gap: 10px;
  margin: 10px 0;
}

.ww-grid label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--ww-muted);
}

.ww-grid input {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
}

.ww-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
  flex-wrap: wrap;
}

.ww-message {
  background: #ccfbf1;
  color: #0f766e;
  border-radius: 6px;
  padding: 8px 12px;
  margin-bottom: 12px;
  font-size: 13px;
}

.ww-modes {
  display: flex;
  gap: 10px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.ww-mode {
  flex: 1;
  min-width: 160px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  text-align: left;
  border: 1px solid var(--ww-border);
  border-radius: 8px;
  background: var(--ww-bg);
  padding: 10px 12px;
  cursor: pointer;
}

.ww-mode small {
  color: var(--ww-muted);
}

.ww-mode-active {
  border-color: var(--ww-teal);
  box-shadow: 0 0 0 1px var(--ww-teal) inset;
  background: #f0fdfa;
}

.ww-page textarea {
  width: 100%;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 8px;
  font-family: inherit;
  font-size: 13px;
}

.ww-hint {
  color: var(--ww-muted);
  font-size: 12px;
  margin: 0 0 6px;
}

input[type='range'] {
  width: 100%;
}
```

- [ ] **Step 3: 构建与类型检查**

Run: `npm run typecheck` && `npm run build`
Expected: 均成功。

- [ ] **Step 4: 手动验证 options**

打开扩展「设置」。
Expected: 修改间隔/形态/位置后立即生效（刷新网页后浮层按新参数展示）；「测试连接」在 free 模式返回示例译义；「导出 JSON」下载文件且 `settings.provider.ai.apiKey` 为空；导入该文件提示导入数量；「立即预览一次浮层」在活动网页上立刻展示。

- [ ] **Step 5: 提交**

```bash
git add src/options src/shared/files.ts src/shared/styles/pages.css
git commit -m "feat: add options page for provider, review and data management"
```

---

### Task 11: manager 生词本管理页

**Files:**
- Create: `src/manager/App.tsx`, `src/manager/style.css`
- Modify: `src/manager/main.tsx`, `src/shared/styles/pages.css`

**Interfaces:**
- Consumes: `sendToBackground`、`downloadJson`/`readJsonFile`、`Entry`、`WordSort`、`formatNextReview`
- Produces: 生词本管理页（搜索、筛选、排序、备注、删除、导入导出、清空）

- [ ] **Step 1: 实现 manager**

`src/manager/main.tsx`:

```tsx
import { createRoot } from 'react-dom/client';
import '../shared/styles/pages.css';
import './style.css';
import { App } from './App';

createRoot(document.getElementById('root')!).render(<App />);
```

`src/manager/App.tsx`:

```tsx
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { downloadJson, readJsonFile } from '../shared/files';
import { sendToBackground } from '../shared/messages';
import type { Entry, EntryKind, ExportBundle, WordSort } from '../shared/types';
import { formatNextReview, hostFromUrl, localDateKey } from '../shared/utils';

type Filter = 'all' | 'due' | EntryKind;

export function App() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [sort, setSort] = useState<WordSort>('created');
  const [expanded, setExpanded] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const result = await sendToBackground<Entry[]>({
      type: 'words:list',
      payload: {
        query: query.trim() || undefined,
        kind: filter === 'word' || filter === 'sentence' ? filter : undefined,
        dueOnly: filter === 'due',
        sort,
      },
    });
    if (result.ok) setEntries(result.data);
    else setMessage(result.error.message);
  }, [query, filter, sort]);

  useEffect(() => {
    const timer = setTimeout(() => void load(), 300);
    return () => clearTimeout(timer);
  }, [load]);

  const dueCount = useMemo(
    () => entries.filter((entry) => entry.srs.dueAt <= Date.now()).length,
    [entries],
  );

  async function saveNote(entry: Entry, note: string) {
    const result = await sendToBackground<Entry>({
      type: 'words:update',
      payload: { id: entry.id, patch: { note } },
    });
    if (result.ok) {
      setEntries((list) => list.map((item) => (item.id === result.data.id ? result.data : item)));
    }
  }

  async function removeEntry(entry: Entry) {
    if (!window.confirm(`删除「${entry.text}」？`)) return;
    const result = await sendToBackground({ type: 'words:delete', payload: { id: entry.id } });
    if (result.ok) setEntries((list) => list.filter((item) => item.id !== entry.id));
  }

  async function exportData() {
    const result = await sendToBackground<ExportBundle>({ type: 'words:export', payload: {} });
    if (!result.ok) {
      setMessage(result.error.message);
      return;
    }
    downloadJson(`word-world-${localDateKey(Date.now())}.json`, result.data);
  }

  async function importData(file: File) {
    try {
      const raw = await readJsonFile(file);
      const data = raw as { entries?: Entry[] };
      if (!Array.isArray(data.entries)) {
        setMessage('文件格式不正确：缺少 entries');
        return;
      }
      const result = await sendToBackground<{ imported: number; skipped: number }>({
        type: 'words:import',
        payload: { entries: data.entries, mode: 'merge' },
      });
      if (result.ok) {
        setMessage(`导入完成：成功 ${result.data.imported}，跳过 ${result.data.skipped}`);
        await load();
      } else {
        setMessage(result.error.message);
      }
    } catch {
      setMessage('JSON 解析失败');
    }
  }

  async function clearAll() {
    if (!window.confirm('确定清空全部生词？此操作不可撤销，建议先导出。')) return;
    const result = await sendToBackground({ type: 'words:clear', payload: {} });
    if (result.ok) {
      setEntries([]);
      setMessage('已清空');
    }
  }

  return (
    <div className="ww-page ww-manager">
      <header className="ww-manager-head">
        <div>
          <h1>生词本</h1>
          <p className="ww-hint">
            共 {entries.length} 条 · 当前列表待复习 {dueCount} 条
          </p>
        </div>
        <div className="ww-actions">
          <button className="ww-btn" onClick={() => void exportData()}>
            导出
          </button>
          <button className="ww-btn" onClick={() => fileRef.current?.click()}>
            导入
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importData(file);
              event.target.value = '';
            }}
          />
          <button className="ww-btn ww-btn-danger" onClick={() => void clearAll()}>
            清空
          </button>
        </div>
      </header>

      {message && <div className="ww-message">{message}</div>}

      <div className="ww-toolbar">
        <input
          className="ww-search"
          placeholder="搜索单词、释义或备注"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <select value={filter} onChange={(event) => setFilter(event.target.value as Filter)}>
          <option value="all">全部</option>
          <option value="word">单词</option>
          <option value="sentence">句子</option>
          <option value="due">待复习</option>
        </select>
        <select value={sort} onChange={(event) => setSort(event.target.value as WordSort)}>
          <option value="created">按创建时间</option>
          <option value="due">按到期时间</option>
          <option value="lookups">按查询次数</option>
        </select>
      </div>

      {entries.length === 0 ? (
        <div className="ww-empty-state">
          <p>没有匹配的词条。</p>
          <p className="ww-hint">去网页上划词查词，结果会自动收录到这里。</p>
        </div>
      ) : (
        <table className="ww-table">
          <thead>
            <tr>
              <th>词条</th>
              <th>释义</th>
              <th>阶段</th>
              <th>下次复习</th>
              <th>查询</th>
              <th>来源</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => {
              const host = hostFromUrl(entry.sourceUrl) ?? '—';
              const isExpanded = expanded === entry.id;
              return (
                <FragmentRow
                  key={entry.id}
                  entry={entry}
                  host={host}
                  expanded={isExpanded}
                  onToggle={() => setExpanded(isExpanded ? null : entry.id)}
                  onSaveNote={(note) => void saveNote(entry, note)}
                  onDelete={() => void removeEntry(entry)}
                />
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FragmentRow({
  entry,
  host,
  expanded,
  onToggle,
  onSaveNote,
  onDelete,
}: {
  entry: Entry;
  host: string;
  expanded: boolean;
  onToggle: () => void;
  onSaveNote: (note: string) => void;
  onDelete: () => void;
}) {
  const [note, setNote] = useState(entry.note ?? '');
  useEffect(() => setNote(entry.note ?? ''), [entry.note]);

  return (
    <>
      <tr className="ww-table-row" onClick={onToggle}>
        <td>
          <span className={`ww-kind ww-kind-${entry.kind}`}>{entry.kind === 'word' ? '词' : '句'}</span>
          <strong>{entry.text}</strong>
        </td>
        <td className="ww-cell-truncate">{entry.translation || '—'}</td>
        <td>{entry.srs.stage}</td>
        <td>{formatNextReview(entry.srs.dueAt, Date.now())}</td>
        <td>{entry.lookups}</td>
        <td>{host}</td>
        <td>
          <button
            className="ww-btn ww-btn-plain"
            onClick={(event) => {
              event.stopPropagation();
              onDelete();
            }}
          >
            删除
          </button>
        </td>
      </tr>
      {expanded && (
        <tr className="ww-detail-row">
          <td colSpan={7}>
            <div className="ww-detail">
              {entry.context && (
                <p>
                  <span className="ww-detail-label">上下文</span>
                  {entry.context}
                </p>
              )}
              {entry.example && (
                <p>
                  <span className="ww-detail-label">例句</span>
                  {entry.example}
                </p>
              )}
              {entry.sourceUrl && (
                <p>
                  <span className="ww-detail-label">来源</span>
                  <a href={entry.sourceUrl} target="_blank" rel="noreferrer">
                    {entry.sourceTitle || entry.sourceUrl}
                  </a>
                </p>
              )}
              <label className="ww-note">
                备注
                <input
                  value={note}
                  onChange={(event) => setNote(event.target.value)}
                  onBlur={() => onSaveNote(note)}
                  placeholder="记点什么，方便以后回忆"
                />
              </label>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
```

> `FragmentRow` 返回 fragment 包裹两个 `<tr>`，React 允许；无需额外依赖。

- [ ] **Step 2: 写 manager 样式（追加到 pages.css 末尾）**

```css
.ww-manager {
  max-width: 1100px;
}

.ww-manager-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 16px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}

.ww-toolbar {
  display: flex;
  gap: 8px;
  margin-bottom: 12px;
  flex-wrap: wrap;
}

.ww-search {
  flex: 1;
  min-width: 220px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 13px;
}

.ww-toolbar select {
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 7px 8px;
  background: #fff;
  font-size: 13px;
}

.ww-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}

.ww-table th {
  text-align: left;
  font-size: 12px;
  color: var(--ww-muted);
  border-bottom: 1px solid var(--ww-border);
  padding: 8px 6px;
  font-weight: 600;
}

.ww-table td {
  border-bottom: 1px solid var(--ww-border);
  padding: 8px 6px;
  vertical-align: top;
}

.ww-table-row {
  cursor: pointer;
}

.ww-table-row:hover {
  background: var(--ww-bg);
}

.ww-cell-truncate {
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ww-kind {
  display: inline-block;
  font-size: 10px;
  border-radius: 4px;
  padding: 0 4px;
  margin-right: 6px;
  color: #fff;
}

.ww-kind-word {
  background: var(--ww-teal);
}

.ww-kind-sentence {
  background: #6366f1;
}

.ww-btn-plain {
  border: 0;
  background: transparent;
  color: #b91c1c;
  padding: 2px 4px;
}

.ww-detail-row td {
  background: #fcfcfd;
}

.ww-detail {
  padding: 6px 4px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: #334155;
}

.ww-detail p {
  margin: 0;
}

.ww-detail-label {
  color: var(--ww-muted);
  margin-right: 8px;
  font-size: 12px;
}

.ww-note {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 520px;
}

.ww-note input {
  flex: 1;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 13px;
}

.ww-empty-state {
  border: 1px dashed var(--ww-border);
  border-radius: 10px;
  padding: 32px;
  text-align: center;
  color: var(--ww-muted);
}
```

- [ ] **Step 3: 构建与类型检查**

Run: `npm run typecheck` && `npm run build`
Expected: 均成功。

- [ ] **Step 4: 手动验证 manager**

从 popup 打开「生词本」。
Expected: 列表展示词条、阶段、下次复习；搜索与筛选生效；展开行可编辑备注并保存（刷新后仍在）；删除有二次确认；导出/导入往返后数据一致；「清空」有二次确认。

- [ ] **Step 5: 提交**

```bash
git add src/manager src/shared/styles/pages.css
git commit -m "feat: add word book manager page with search, notes and import/export"
```

---

### Task 12: 收尾验证与 README

**Files:**
- Create: `README.md`
- Test: `tests/` 全量

**Interfaces:**
- Consumes: 全部前置任务
- Produces: 可交付的构建产物与使用说明

- [ ] **Step 1: 写 README**

`README.md`:

```markdown
# Word World

划词查词/翻译 + 生词本 + 网页随机复习的 Chrome/Edge 扩展（Manifest V3）。

## 开发

```bash
npm install
npm run icons      # 生成 public/icons
npm run build      # 输出到 dist/
npm run test       # Vitest 单元测试
npm run typecheck
```

加载：打开 `chrome://extensions` → 开启开发者模式 → 加载已解压的扩展程序 → 选择 `dist/`。

## 功能

- 网页选中文字 → 点击「译」图标查词/翻译，结果自动收录
- 生词本按简化 SRS 调度，浏览网页时以字幕条 / 弹幕 / 角落卡片浮现复习
- popup 查看今日统计与快捷开关；设置页配置数据源、频率、形态与站点暂停
- 生词本管理页支持搜索、筛选、备注、导入导出 JSON

## 数据源

- 免费模式：dictionaryapi.dev + Google 公开翻译端点，失败回退 MyMemory
- AI 模式：任意 OpenAI 兼容 `/chat/completions`，失败自动回退免费接口

API Key 仅保存在本机 `chrome.storage.local`，不会出现在导出文件中，也没有任何遥测。Google 公开端点在部分网络环境不可达，可在设置中改用 AI。

## 已知限制

- 只支持 Chrome / Edge；`chrome://`、扩展商店、PDF 阅读器页面不注入
- 免费接口有限流；AI 接口按服务商计费
- 生词数据仅存本地，无云同步
```

- [ ] **Step 2: 全量测试、类型检查与构建**

Run: `npm test`
Expected: 所有测试文件 PASS。

Run: `npm run typecheck`
Expected: 无错误。

Run: `npm run build`
Expected: 成功，检查 `dist/`：

```bash
ls -l dist/content.js dist/background.js
```

Expected: `content.js` 小于 250KB（压缩后）；`dist/manifest.json` 中的路径均存在。

- [ ] **Step 3: 完整手动验收清单（逐条记录结果）**

1. 英文新闻页选中单词 → 「译」→ 音标/释义/例句/译义正确 → 生词本新增。
2. 选中整句 → 译文正确，类型为句子（manager 中显示「句」）。
3. 重复查询同一词 → 卡片显示「第 2 次查询」，无重复条目。
4. 设置间隔 60s → 等待 1–2 分钟 → 字幕条浮现；切换三种形态分别验证；评分后 manager 中「下次复习」与提示一致。
5. 站点暂停 → 当前站点 2 分钟内不弹，其他站点正常。
6. 输入框聚焦、切到后台标签、全屏视频时不弹。
7. AI 错误 Key → 卡片出现「AI 失败，已回退免费接口」；填正确 Key 后结果含例句且标记 AI。
8. DevTools Offline 后查新词 → 错误 + 重试；查已有词 → 显示「离线缓存」。
9. manager 搜索 / 筛选 / 备注 / 删除 / 导出导入往返一致。
10. GitHub 等严格 CSP 页面：划词卡片样式正常；SPA 站内跳转后功能仍正常。

- [ ] **Step 4: 提交**

```bash
git add README.md
git commit -m "docs: add README and finish v1 verification"
```

---

## 自审记录

- **Spec 覆盖**：构建/manifest（Task 1）、数据模型与消息（Task 2/4/6）、SRS（Task 3）、数据源（Task 5）、划词（Task 7）、复习三形态（Task 8）、三个页面（Task 9/10/11）、错误处理（分散在各任务 + Task 12 验收）、测试（各任务）。无遗漏。
- **占位符**：无 TBD/TODO；每个代码步骤均为完整实现。
- **类型一致性**：`LookupResponse`、`PublicSettings`、`startScheduler`、`sendToBackground`、`upsertLookup`、`formatNextReview` 在各任务间名称与签名一致。
- **已知偏差**：HTML 入口放在仓库根目录（Vite 多页面输出路径需要），spec 中 `src/*/index.html` 的表述以本计划为准。
