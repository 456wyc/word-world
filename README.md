# Word World

划词查词/翻译 + 生词本 + 网页随机复习的 Chrome/Edge 扩展（Manifest V3）。

- 项目主页：<https://456wyc.github.io/word-world/>
- 隐私政策：[PRIVACY.md](PRIVACY.md)
- 许可证：MIT

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

## 发布

商店上架文案、截图清单见 [docs/store-listing.md](docs/store-listing.md)，隐私政策见 [PRIVACY.md](PRIVACY.md)。

```bash
npm run build
# 打包 dist 内容（注意不要多套一层 dist/ 目录）
```

上传至 [Chrome 网上应用店开发者后台](https://chrome.google.com/webstore/devconsole)，审核通常需要 1–3 个工作日。

## 已知限制

- 只支持 Chrome / Edge；`chrome://`、扩展商店、PDF 阅读器页面不注入
- 免费接口有限流；AI 接口按服务商计费
- 生词数据仅存本地，无云同步
