# Google Maps 数据采集工具

基于 Node.js + Playwright 的 Google Maps 商家信息批量采集工具。

## 功能特性

- **批量采集**：输入关键词和城市，自动采集搜索结果中的商家信息
- **数据字段**：商家名称、地址、电话、评分、评论数、网站链接
- **实时进度**：SSE 实时推送采集进度，前端界面同步更新
- **数据导出**：支持 CSV 和 Excel 两种导出格式
- **反爬策略**：非 headless 模式运行、随机延迟、模拟人类操作

## 快速开始

### 1. 安装依赖

```bash
npm install
npx playwright install chromium
```

### 2. 启动服务

```bash
npm start
```

### 3. 使用

打开浏览器访问 [http://localhost:3000](http://localhost:3000)，输入关键词开始采集。

## 技术栈

- **后端**：Node.js + Express
- **采集引擎**：Playwright (Chromium)
- **前端**：HTML + Tailwind CSS
- **数据导出**：xlsx (SheetJS)

## 项目结构

```
google-maps-scraper/
├── server.js              # Express 服务器 + API 路由
├── scraper/
│   ├── engine.js          # Playwright 采集引擎
│   └── selectors.js       # CSS 选择器配置
├── public/
│   └── index.html         # 前端界面
└── exports/               # 导出文件目录
```

## 注意事项

- Google Maps 的 CSS 类名会定期变更，选择器配置集中在 `scraper/selectors.js`，失效时更新该文件即可
- 遇到人机验证时，系统会暂停并提示在浏览器中手动完成验证
- 建议单次采集不超过 200 条，降低被风控的概率

## License

MIT
