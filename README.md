# Google Maps 数据采集工具

Google Maps 商家信息批量采集工具，提供两种使用方式：**Chrome 扩展**（推荐）和 **网页应用**。

## 功能特性

- **批量采集**：输入关键词和城市，自动采集搜索结果中的商家信息
- **数据字段**：商家名称、地址、电话、评分、评论数、网站链接
- **数据导出**：支持 CSV 和 Excel 两种导出格式
- **反爬策略**：随机延迟、模拟人类操作

---

## 方式一：Chrome 扩展（推荐）

安装后直接在 Google Maps 页面操作采集，无需后端服务。

### 安装步骤

1. 下载或 clone 本仓库
2. 打开 Chrome 浏览器，进入 `chrome://extensions/`
3. 开启右上角「开发者模式」
4. 点击「加载已解压的扩展程序」
5. 选择本仓库的 `extension/` 目录

### 使用方法

1. 在 Google Maps 搜索关键词（如 "咖啡厅 北京"）
2. 点击浏览器右上角的扩展图标
3. 设置采集数量，点击「开始采集」
4. 采集完成后，打开「数据面板」查看数据
5. 点击「导出 CSV」或「导出 Excel」下载数据

### 扩展结构

```
extension/
├── manifest.json              # 扩展配置 (Manifest V3)
├── content/
│   ├── content.js             # 注入 Google Maps 的采集脚本
│   └── selectors.js           # CSS 选择器配置
├── background/
│   └── service-worker.js      # 消息中转 + 数据存储
├── popup/
│   ├── popup.html             # 弹出控制面板
│   └── popup.js               # 控制面板逻辑
├── sidepanel/
│   ├── sidepanel.html         # 数据展示面板
│   └── sidepanel.js           # 数据表格 + 导出
├── utils/
│   └── export.js              # 导出工具函数
└── icons/                     # 扩展图标
```

---

## 方式二：网页应用（本地运行）

基于 Node.js + Playwright 的网页应用，需要本地运行。

### 安装与启动

```bash
npm install
npx playwright install chromium
npm start
```

打开浏览器访问 [http://localhost:3000](http://localhost:3000)，输入关键词开始采集。

### 技术栈

- **后端**：Node.js + Express
- **采集引擎**：Playwright (Chromium)
- **前端**：HTML + Tailwind CSS
- **数据导出**：xlsx (SheetJS)

## 注意事项

- Google Maps 的 CSS 类名会定期变更，选择器配置集中在 `selectors.js`，失效时更新该文件即可
- 遇到人机验证时，系统会暂停并提示在页面中手动完成验证
- 建议单次采集不超过 200 条，降低被风控的概率

## License

MIT
