# Word World 浏览器扩展设计（v1）

日期：2026-10-29
状态：待实现

## 1. 背景与目标

用户在日常浏览网页时需要查词/翻译，并且希望把查过的内容沉淀下来，在浏览时以轻量浮层随机复习。v1 交付一个可加载到 Chrome / Edge 的 MV3 扩展，完成三件事：

1. 网页划词查词与整句翻译；
2. 查询结果自动收录进本地生词本，并提供管理、搜索、导入导出；
3. 按简化间隔重复（SRS）在网页上以字幕条 / 弹幕 / 角落卡片三种形态浮现复习。

## 2. 范围

### v1 包含

- 划词小图标 + 查词卡片（单词释义、音标、例句、中文译义；整句翻译）
- 免费数据源（dictionaryapi.dev + Google 公开翻译端点 + MyMemory 回退）与 OpenAI 兼容 AI 数据源（可在设置中切换）
- 本地生词本（`chrome.storage.local`），自动收录、备注、删除、搜索、筛选、导入导出 JSON
- 简化 SRS 调度与三种复习浮层形态
- popup、options、manager 三个扩展页面
- 今日统计（待复习 / 今日已复习 / 今日新增）

### v1 不包含

账号与云同步、离线词库、Anki/欧路导入导出、AI 对话式讲解、自定义词典与快捷键、Firefox/Safari 适配（代码保持可移植，但只验收 Chrome/Edge）。

## 3. 技术选型

| 项 | 选择 |
|---|---|
| 扩展标准 | Manifest V3（Chrome / Edge） |
| 构建 | Vite 6 + TypeScript，npm 管理依赖 |
| UI | React 18（popup / options / manager / content UI） |
| 样式 | 手写 CSS + CSS 变量 token，不引 UI 库、不外链字体与图标 |
| 单元测试 | Vitest |
| 存储 | `chrome.storage.local` + `unlimitedStorage` |
| 运行模型 | background service worker 作为唯一数据与网络网关 |

## 4. 架构

```
┌─────────────── 网页上下文（content script, Shadow DOM） ───────────────┐
│  划词面板 SelectionUI              复习浮层 ReviewOverlay（3 种形态）     │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ chrome.runtime 类型化消息
┌───────────────────────────▼──────────────────────────────────────────┐
│ background service worker                                             │
│  · messages：lookup / review:next / review:rate / words:* / settings:* │
│  · providers：free（词典 + 免费翻译）│ ai（OpenAI 兼容）                 │
│  · srs.ts：纯函数，选词、评分推进、到期计算                              │
│  · storage.ts：读写、缓存、版本迁移                                      │
└───────────────────────────┬──────────────────────────────────────────┘
                            │ chrome.storage.local
┌───────────────────────────▼──────────────────────────────────────────┐
│ popup（最近生词/开关）  options（设置）  manager（生词本管理页，新标签页） │
└──────────────────────────────────────────────────────────────────────┘
```

### 为什么由 SW 统一代理

- 绕过页面 CORS：`host_permissions` 下由 SW 发请求；
- 生词数据单写入口，避免多页面并发写覆盖；
- AI Key 只存在于 `chrome.storage.local` 与 SW / options 页面，不进入网页上下文。

### 构建

三个独立构建目标，产物统一到 `dist/`：

1. **页面构建**：`vite build`，入口为仓库根目录的 `popup.html`、`options.html`、`manager.html`（各自引用 `src/<page>/main.tsx`），`base: './'`，自动复制 `public/manifest.json` 与 `public/icons/`。
2. **content 构建**：`vite build -c vite.content.config.ts`，`build.lib` 以 IIFE 输出单文件 `content.js`（MV3 content script 不支持 ESM）。style 通过 `?inline` 导入字符串，注入构造式样式表。
3. **background 构建**：`vite build -c vite.background.config.ts`，ESM 输出单文件 `background.js`。

`npm run build` 依次执行三者（先清理 `dist/`）。开发流程：`npm run watch`（三个构建 watch）+ 在 `chrome://extensions` 重新加载。

### manifest

```json
{
  "manifest_version": 3,
  "name": "Word World",
  "version": "0.1.0",
  "description": "划词查词翻译，生词本与随机复习",
  "permissions": ["storage", "unlimitedStorage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "background.js", "type": "module" },
  "content_scripts": [{
    "matches": ["<all_urls>"],
    "js": ["content.js"],
    "run_at": "document_idle",
    "all_frames": false
  }],
  "action": { "default_popup": "popup.html" },
  "options_page": "options.html",
  "icons": { "16": "icons/16.png", "32": "icons/32.png", "48": "icons/48.png", "128": "icons/128.png" }
}
```

`<all_urls>` 同时用于 content script 注入与任意 AI baseUrl 请求，也使 popup 能读取当前标签页 URL（「本站暂停」）。manager 页由 `chrome.tabs.create({ url: chrome.runtime.getURL('manager.html') })` 打开，无需额外权限。图标为本地生成的简单 PNG（16/32/48/128），不依赖外部资源。

## 5. 目录结构

```
public/
  manifest.json
  icons/{16,32,48,128}.png
popup.html  options.html  manager.html   # Vite 页面入口（根目录）
src/
  background/
    index.ts            # 消息路由入口
    messages.ts         # 各消息处理器
    storage.ts          # entries/settings/stats/cache 读写、迁移、导入导出
    srs.ts              # SRS 纯函数 + 选词
    providers/
      index.ts          # provider 链、缓存、单词/句子判定
      free.ts           # dictionaryapi.dev + Google 翻译 + MyMemory 回退
      ai.ts             # OpenAI 兼容 chat/completions
  content/
    index.tsx           # 启动划词 UI 与复习调度
    shadowHost.ts       # Shadow DOM 挂载、构造式样式表
    selection/
      Trigger.tsx       # 选区旁小图标
      LookupCard.tsx    # 查词结果卡片
    review/
      Overlay.tsx       # 三形态容器与评分
      SubtitleMode.tsx
      BarrageMode.tsx
      CardMode.tsx
    scheduler.ts        # 复习计时、跳过条件、设置监听
  popup/ options/ manager/   # 三个页面的 main.tsx + App.tsx + 样式
  shared/
    types.ts  messages.ts  constants.ts  utils.ts
    styles/tokens.css  styles/base.css
tests/                 # Vitest
vite.config.ts  vite.content.config.ts  vite.background.config.ts
```

## 6. 数据模型

存储键带前缀与版本，读取时通过 `ww.schema` 做迁移（v1 初始版本，迁移表为空）。

### Entry（`ww.entries.v1`，以 id 为键的对象）

```ts
type EntryKind = 'word' | 'sentence';
type Rating = 'known' | 'unsure' | 'unknown';

interface Entry {
  id: string;                 // crypto.randomUUID()
  text: string;               // 规范化后的原文（trim，内部空白合并）
  kind: EntryKind;
  translation: string;        // 主释义 / 译文（中文优先）
  phonetic?: string;
  senses?: { pos?: string; def: string }[];
  example?: string;
  context?: string;           // 查词时所在句子（≤300 字符）
  sourceUrl?: string;         // 仅 http/https
  sourceTitle?: string;
  createdAt: number;
  updatedAt: number;
  lookups: number;            // 查询次数，首次为 1
  note?: string;
  srs: SrsState;
}

interface SrsState {
  stage: number;              // 0 = 新词
  dueAt: number;
  lastReviewedAt?: number;
  reps: number;
  lapses: number;
  knownStreak: number;
}
```

以对象存储并整体读写该键；词量预期 < 10k，单次序列化开销可接受。

### Settings（`ww.settings.v1`）

```ts
interface Settings {
  provider: {
    mode: 'free' | 'ai';
    ai: { baseUrl: string; apiKey: string; model: string };
  };
  review: {
    enabled: boolean;             // 默认 true
    intervalSec: number;          // 默认 180，范围 60–1800
    displayMode: 'subtitle' | 'barrage' | 'card';   // 默认 subtitle
    position: 'bottom' | 'top';   // 默认 bottom（barrage 忽略）
    durationSec: number;          // 默认 8，范围 4–30
    pausedHosts: string[];        // 例如 ["news.ycombinator.com"]
  };
}
```

读取设置时与默认值深合并，未知字段丢弃。

### Stats（`ww.stats.v1`）

```ts
interface Stats {
  date: string;        // YYYY-MM-DD（本地时区）
  shown: number;       // 浮层展示次数
  reviewed: number;    // 评分次数
  added: number;       // 新增词条数
}
```

跨天首次访问时重置计数。

### Cache（`ww.cache.v1`）

```ts
type CacheKey = `${'free' | 'ai'}:${string}`;   // provider:规范化文本
interface CacheRecord { result: LookupPayload; cachedAt: number; }
```

TTL 7 天，最多保留 500 条，超出按 `cachedAt` 升序淘汰。

## 7. 消息协议

所有消息为 `{ type, payload }`，响应统一 `{ ok: true, data } | { ok: false, error: { code, message } }`。SW 入口按 `type` 分发，未识别类型返回 `UNKNOWN_MESSAGE`。

| type | payload | data |
|---|---|---|
| `lookup` | `{ text, context?, sourceUrl?, sourceTitle? }` | `{ entry, provider: 'free'\|'ai', cached, fallbackReason: 'ai-unconfigured'\|'ai-error'\|'rate-limit'\|null }` |
| `review:next` | `{ host, recentIds: string[] }` | `{ entry } \| null` |
| `review:rate` | `{ id, rating }` | `{ entry, dueAt }` |
| `words:list` | `{ query?, kind?, dueOnly?, sort?: 'due'\|'created'\|'lookups' }` | `Entry[]` |
| `words:update` | `{ id, patch: { note?, translation? } }` | `Entry` |
| `words:delete` | `{ id }` | `{ deleted: true }` |
| `words:clear` | `{}` | `{ cleared: true }` |
| `words:import` | `{ entries, mode: 'merge'\|'replace' }` | `{ imported, skipped }` |
| `words:export` | `{}` | `{ entries, settings, exportedAt }` |
| `settings:get` | `{}` | `Settings`（仅扩展页面使用） |
| `settings:public` | `{}` | `PublicSettings`（content 使用，不含 API Key） |
| `settings:update` | `Partial<Settings>`（深合并） | `Settings` |
| `provider:test` | `{}` | `{ provider, sample }` |
| `stats:get` | `{}` | `Stats` |
| `review:preview` | `{ mode }` | `{ shown: boolean }`（options → SW → 当前活动标签页 content） |

`lookup` 在 SW 内完成：规范化文本 → 判定 kind → 查缓存 → 调 provider → 写入/更新 Entry → 更新 stats.added → 返回。

校验规则（SW 侧）：`text` 为非空字符串且 ≤ 400 字符；`sourceUrl` 仅允许 http/https；`rating` 必须是三个枚举之一；`note` ≤ 1000 字符。

## 8. 数据源

### 单词/句子判定

规范化文本后：不含空白且不含句末标点，或单词数 ≤ 2 且无标点，且只含拉丁字母/连字符/撇号 → `word`；否则 `sentence`。中文选中恒为 `sentence`（走翻译），除非是单个 CJK 词且后续确需词典支持时再扩展。

### free 链

- 单词：`GET https://api.dictionaryapi.dev/api/v2/entries/en/{word}` 取音标、词性、释义、例句；同时请求中文译义。
- 翻译：首选 `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=...`（非官方公开端点，可能不可达）；失败回退 `https://api.mymemory.translated.net/get?q=...&langpair=en|zh-CN`（长文本截断至 500 字符）。
- 目标语言判定：文本含 CJK → 译为英文（`tl=en` / `langpair=zh-CN|en`），否则译为中文。
- 词典请求失败但翻译成功：仍返回条目（无 senses），卡片显示译义；两者都失败才报错。

### ai

- `POST {baseUrl}/chat/completions`，`temperature: 0.2`，messages 要求**只返回 JSON**：

```json
{
  "translation": "中文译义/译文",
  "phonetic": "/ˈwɜːrd/",
  "senses": [{ "pos": "n.", "def": "中文释义" }],
  "example": "英文例句（可含中文对照）"
}
```

- 单词查询时附带 `context` 帮助消歧；句子查询只要求 `translation`。
- 解析：剥离 ```json 代码围栏后截取首个 `{...}`，`JSON.parse` 后用类型守卫校验；失败按错误处理。
- 失败回退 free，返回值 `fallback: true`，content 端每页最多提示一次。

### 请求策略

- 8 秒超时（`AbortController`），不做自动重试（用户可点重试）。
- 结果写缓存；命中缓存返回 `cached: true`。
- 所有请求只发往用户配置的数据源，无遥测。

## 9. SRS 算法（`srs.ts`，纯函数）

```ts
const WORD_INTERVALS_MS  = [0, 1d, 3d, 7d, 16d, 35d];   // 索引 = stage，stage 0 不用
const SENT_INTERVALS_MS  = [0, 1d, 4d, 15d];             // 句子最高 stage 3
const WORD_MAX_STAGE = 5;
const SENT_MAX_STAGE = 3;
```

- **创建**：`stage = 0`，`dueAt = now + 10min`，`reps = 0`，`lapses = 0`，`knownStreak = 0`。
- **认识**：`stage = min(stage + 1, max)`，`knownStreak++`，`reps++`，`dueAt = now + interval[stage]`。
- **模糊**：`stage` 不变，`reps++`，`knownStreak = 0`，`dueAt = now + 60min`。
- **不认识**：`stage = max(0, stage - 1)`，`lapses++`，`knownStreak = 0`，`reps++`，`dueAt = now + 10min`。
- **重复查询**：`lookups++`，`dueAt = min(dueAt, now)`，stage 与其他字段不变。
- **选词（`pickNext(entries, now, recentIds)`）**：过滤 `dueAt <= now` 且不在 `recentIds` 中，按 `dueAt` 升序取第一条；无则返回 null。新词天然因 `dueAt = createdAt + 10min` 进入队列。
- **提示文案**：由 `dueAt - now` 格式化为「10 分钟后 / 3 天后 / 1 小时后」等。

## 10. 划词查词交互

1. 监听 `mouseup`，150ms 防抖获取选区；校验：非空、≤ 400 字符、选区不在 `input / textarea / [contenteditable]` 内、不位于扩展 Shadow DOM 内。
2. 在选区末尾（视口内）显示 24px 圆形「译」图标；选区变化或点击别处时移除。图标点击不冒泡到页面。
3. 点击后紧贴选区打开卡片（超出视口自动翻转到上方/左侧），先发 `lookup`，显示 loading 骨架。
4. 卡片内容：
   - 单词：词条 + 音标 + 发音按钮（Web Speech API，`lang = 'en-US'`，不可用时隐藏）+ 词性释义列表 + 例句 + 分隔线 + 中文译义；
   - 句子：原文（可选中）+ 译文；
   - 已存在时显示「已收录 · 第 N 次查询」；
   - AI 回退时显示「已回退免费接口」；
   - 操作：复制 / 移出生词本（`words:delete`）/ 关闭。
5. 关闭：ESC、点击卡片外部、再次触发划词。页面滚动时关闭卡片（避免定位漂移）。
6. 查询失败不写入生词本；卡片显示错误与「重试」；若 `mode === 'ai'` 且未配置 Key，显示「去设置里配置 AI」链接（`chrome.runtime.openOptionsPage()`）。

UI 渲染使用 `textContent` / React 文本节点，禁止 `innerHTML`（防页面或接口内容注入）。

## 11. 复习浮层与调度

### 三种形态

| 形态 | 呈现 | 交互 |
|---|---|---|
| subtitle | 底部（或顶部）居中深色半透明字幕条，一行 `word /音标/ 译义`，顶部 3px 进度条 | 悬停展开例句与评分按钮；`durationSec` 后淡出 |
| barrage | 底部 1/3 从右向左单行道飘过，速度按文本长度自适应（约 120px/s，长文本加速）；同一时刻只允许一条 | 点击停住并展开为迷你卡片评分；走出屏幕消失；`prefers-reduced-motion` 时降级为 subtitle |
| card | 右下角卡片，含音标、释义、例句 | 直接展示评分按钮，可手动关闭，`durationSec` 后淡出 |

- 句子条目展示原文 + 译文（截断到 4 行，展开可看全）。
- 评分按钮：认识（绿）/ 模糊（琥珀）/ 不认识（红）。评分后浮层消失并出 1.5s 轻提示「已记录 · {下次复习时间}」；消息失败则提示「保存失败，请稍后重试」，SRS 不变。
- 未评分自动消失：不更新 SRS，仅 `stats.shown++`。
- 三种形态共用同一个 `Overlay` 容器、同一份数据与评分逻辑，形态组件只负责渲染与动画。

### 跳过条件

满足任一即跳过本轮：`document.hidden`、焦点在 `input/textarea/[contenteditable]`、页面存在非空选区、`document.fullscreenElement` 存在、划词卡片正打开、当前 host 在 `pausedHosts` 中、`review.enabled = false`。

### 调度

- content 加载后向 SW 取一次设置；`review:preview` 可强制立即展示一次（options 调试用）。
- 每个页面一个定时器：`delay = intervalSec × random(0.8, 1.2)`；触发且未跳过时发 `review:next`（携带本页最近 5 个已展示 id），有结果则渲染，渲染后重置计时；跳过则短延迟（30s）后重试。
- 成功后 `stats.shown++` 由 SW 在 `review:next` 时完成。
- `chrome.storage.onChanged` 监听设置：关闭开关或暂停当前站点时清除计时器并移除当前浮层；重新开启时重新计时。

### Shadow DOM 与样式

- 每个 UI 根挂载到独立的 `div`，`shadowRoot` 内放入 React 根节点；宿主样式 `all: initial`，`position: fixed`，最高层 `z-index: 2147483647`（图标/卡片另起根节点，互不影响）。
- 样式通过 `new CSSStyleSheet()` + `adoptedStyleSheets` 注入；不支持时回退 `<style>`。
- 只对实际可交互元素设置 `pointer-events: auto`，避免遮挡页面点击。
- 动效仅使用 `transform` / `opacity`，不触发布局。

## 12. 三个扩展页面

### popup

- 顶部：今日统计（待复习 n / 已复习 m / 新增 k）。
- 中部：最近 7 条生词（按 createdAt 倒序），点击打开 manager。
- 开关：复习总开关、在本站暂停（读取当前活动标签页 host；无活动网页时禁用）。
- 底部按钮：打开生词本 / 设置。

### options

- 数据源：free / AI 单选；AI 模式下 baseUrl、API Key（password 输入）、model；「测试连接」调用 `provider:test` 显示成功/失败。
- 复习：总开关、间隔滑杆（60–1800s，步进 30）、形态三选一（带静态预览图）、位置（上/下）、停留时长（4–30s）。
- 站点暂停列表：标签式增删，支持手动输入 host。
- 数据：导出 JSON（`words:export` 下载）、导入 JSON（merge / replace）、清空全部（二次确认）。
- 调试：「立即预览一次浮层」，向活动标签页发送 `review:preview`。

### manager（新标签页）

- 顶部统计 + 搜索框（300ms 防抖）+ 筛选（全部 / 单词 / 句子 / 待复习）+ 排序（到期时间 / 创建时间 / 查询次数）。
- 列表列：词条、译义（截断）、stage / 下次复习、查询次数、来源域名、操作。
- 行展开：上下文句子、来源链接（新标签页打开）、备注编辑（失焦保存）。
- 操作：删除（二次确认）；顶部：导出 / 导入 / 清空。
- 空状态：引导去网页划词。

## 13. 错误处理

| 场景 | 行为 |
|---|---|
| 请求超时 / 断网 | 有缓存 → 显示缓存并标注「离线缓存」；无缓存 → 卡片错误 + 重试，不写生词本 |
| AI 401/429/超时/JSON 解析失败 | 回退 free；卡片提示「已回退免费接口」，每页最多一次 |
| 免费接口全部失败 | 按链回退；错误文案区分「网络异常」与「接口限流，请稍后再试」 |
| 复习浮层取词失败 | 静默跳过，30s 后重试 |
| `Receiving end does not exist` | 300ms 后重试一次 |
| 存储写入失败 / 配额超限 | 扩展页面显示错误条并提示导出后清理；浮层评分失败轻提示 |
| 同词多标签页并发评分 | SW 内按消息串行处理，后写覆盖，返回最新 Entry |
| 严格 CSP 页面样式被拦 | `adoptedStyleSheets` 优先，回退 `<style>` |
| 禁止注入的页面（`chrome://`、Web Store、PDF） | 预期不支持 |

## 14. 安全与隐私

- API Key 仅存 `chrome.storage.local`，只在 SW 与 options 使用；content script 只接收 `settings:public`（不含 Key）。
- 导出 JSON 时剔除 API Key（`provider.ai.apiKey` 置空），避免密钥随文件外泄。
- 所有页面与接口返回内容以纯文本渲染，禁止 `innerHTML`；链接 `href` 仅允许 http/https。
- SW 对消息 payload 做类型与长度校验；未知 type 拒绝。
- 无遥测、无第三方统计，请求仅发往用户选择的数据源。
- 导入 JSON 时校验结构，非法条目跳过并计数。

## 15. 测试与验收

### 单元测试（Vitest）

- `srs.ts`：认识/模糊/不认识推进、stage 上下限、连续忘记、重复查询不重置 stage、`pickNext` 到期排序与 recentIds 排除、句子与单词不同阶梯、文案格式化。
- `utils.ts`：文本规范化、单词/句子判定、CJK 检测、日期格式化。
- `storage.ts`：默认设置合并、跨天统计重置、缓存 TTL 与 500 条淘汰、导入校验（mock `chrome.storage`）。
- `providers`：词典/Google/MyMemory/AI 响应解析（JSON fixture 与异常 fixture）、provider 回退顺序（mock `fetch`）。
- `messages.ts`：各消息成功与非法 payload 分支（mock storage 与 providers）。

### 静态检查

`tsc --noEmit` 通过；构建产物检查：`dist/manifest.json` 路径正确、`content.js` 为单文件、无外链资源、`content.js` 压缩后 < 250KB。

### 手动端到端（Chrome 加载 `dist/` 解压扩展，逐条记录）

1. 新闻页选中单词 → 图标出现 → 释义/音标/译义正确 → 生词本新增该词。
2. 选中整句 → 译文正确，kind 为 sentence。
3. 重复查询同一词 → 显示「第 2 次查询」，无重复条目。
4. 间隔设为 60s → 三种形态各展示一次；评分后 manager 中 dueAt 与提示文案一致。
5. 本站暂停 → 当前站不弹，其他站点正常。
6. 输入框聚焦、后台标签、全屏视频时不弹。
7. AI 错误 Key → 回退 free 且有提示；正确 Key → 返回例句。
8. 断网查新词 → 错误 + 重试；断网查旧词 → 缓存结果。
9. manager 搜索/筛选/改备注/删除/导出导入往返数据一致。
10. SPA 跳转、页面刷新后正常；GitHub 等严格 CSP 页面样式正常。

## 16. 风险

- Google 公开翻译端点在部分网络环境不可达 → MyMemory 回退 + 文案引导配置 AI。
- 非官方端点可能变更或失效 → provider 抽象层可替换实现，不影响其余模块。
- dictionaryapi.dev 限流 → 7 天缓存兜底。
- `chrome.storage.local` 全量读写随词量增长变慢 → 万级以内可接受；超出时再迁移 IndexedDB（存储层已隔离）。
