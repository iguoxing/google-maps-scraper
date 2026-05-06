const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const XLSX = require('xlsx');
const ScraperEngine = require('./scraper/engine');

const app = express();
const PORT = process.env.PORT || 3000;
const EXPORTS_DIR = path.join(__dirname, 'exports');

// 确保导出目录存在
if (!fs.existsSync(EXPORTS_DIR)) {
  fs.mkdirSync(EXPORTS_DIR, { recursive: true });
}

// 中间件
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 采集引擎实例（全局单例）
const scraper = new ScraperEngine();

// SSE 连接管理
let sseClients = [];

function broadcastSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(client => {
    try {
      client.res.write(message);
    } catch (e) {
      // 客户端已断开
    }
  });
}

// 设置进度回调
scraper.setProgressCallback((progress) => {
  broadcastSSE('progress', progress);
});

// ==================== API 路由 ====================

/**
 * 启动采集任务
 * POST /api/start
 * Body: { keyword: string, city: string, maxResults: number }
 */
app.post('/api/start', async (req, res) => {
  try {
    const { keyword, city = '', maxResults = 50 } = req.body;

    if (!keyword || keyword.trim().length === 0) {
      return res.status(400).json({ error: '请输入搜索关键词' });
    }

    if (scraper.isRunning) {
      return res.status(409).json({ error: '已有采集任务在运行中' });
    }

    // 异步启动采集
    scraper.start({
      keyword: keyword.trim(),
      city: city.trim(),
      maxResults: Math.min(Math.max(parseInt(maxResults) || 50, 1), 500),
    }).catch(err => {
      console.error('采集任务异常:', err);
    });

    res.json({ message: '采集任务已启动' });
  } catch (err) {
    console.error('启动采集失败:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * 停止采集任务
 * POST /api/stop
 */
app.post('/api/stop', (req, res) => {
  scraper.stop();
  res.json({ message: '正在停止采集...' });
});

/**
 * 获取采集进度（SSE 实时推送）
 * GET /api/progress
 */
app.get('/api/progress', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });

  const client = { id: Date.now(), res };
  sseClients.push(client);

  // 立即发送当前状态
  res.write(`event: progress\ndata: ${JSON.stringify({
    ...scraper.progress,
    data: scraper.collectedData,
  })}\n\n`);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== client.id);
  });
});

/**
 * 获取已采集的数据
 * GET /api/data
 */
app.get('/api/data', (req, res) => {
  res.json({
    data: scraper.collectedData,
    progress: scraper.progress,
  });
});

/**
 * 清除已采集的数据
 * POST /api/clear
 */
app.post('/api/clear', (req, res) => {
  scraper.collectedData = [];
  scraper.progress = {
    status: 'idle',
    current: 0,
    total: 0,
    success: 0,
    failed: 0,
    message: '',
  };
  broadcastSSE('progress', scraper.progress);
  res.json({ message: '数据已清除' });
});

/**
 * 导出 CSV
 * GET /api/export/csv
 */
app.get('/api/export/csv', (req, res) => {
  if (scraper.collectedData.length === 0) {
    return res.status(400).json({ error: '没有可导出的数据' });
  }

  const fields = ['name', 'address', 'phone', 'rating', 'reviews', 'website'];
  const headers = ['商家名称', '地址', '电话', '评分', '评论数', '网站链接'];
  const BOM = '\uFEFF'; // UTF-8 BOM（确保 Excel 正确识别中文）

  let csv = BOM + headers.join(',') + '\n';
  scraper.collectedData.forEach(row => {
    const values = fields.map(field => {
      let val = row[field] || '';
      // CSV 转义
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    });
    csv += values.join(',') + '\n';
  });

  const filename = `google-maps-data-${new Date().toISOString().slice(0, 10)}.csv`;
  const filepath = path.join(EXPORTS_DIR, filename);

  fs.writeFileSync(filepath, csv, 'utf-8');

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(filename)}"`);
  res.send(csv);
});

/**
 * 导出 Excel
 * GET /api/export/excel
 */
app.get('/api/export/excel', (req, res) => {
  if (scraper.collectedData.length === 0) {
    return res.status(400).json({ error: '没有可导出的数据' });
  }

  const headers = ['商家名称', '地址', '电话', '评分', '评论数', '网站链接'];
  const fields = ['name', 'address', 'phone', 'rating', 'reviews', 'website'];

  const wsData = [headers];
  scraper.collectedData.forEach(row => {
    wsData.push(fields.map(field => row[field] || ''));
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);

  // 设置列宽
  ws['!cols'] = [
    { wch: 30 }, // 商家名称
    { wch: 50 }, // 地址
    { wch: 20 }, // 电话
    { wch: 8 },  // 评分
    { wch: 10 }, // 评论数
    { wch: 40 }, // 网站链接
  ];

  XLSX.utils.book_append_sheet(wb, ws, 'Google Maps 数据');

  const filename = `google-maps-data-${new Date().toISOString().slice(0, 10)}.xlsx`;
  const filepath = path.join(EXPORTS_DIR, filename);

  XLSX.writeFile(wb, filepath);
  res.download(filepath, filename);
});

// ==================== 启动服务器 ====================

app.listen(PORT, () => {
  console.log(`\n  Google Maps 数据采集工具已启动`);
  console.log(`  本地访问: http://localhost:${PORT}`);
  console.log(`  按 Ctrl+C 停止服务器\n`);
});

// 优雅退出
process.on('SIGINT', async () => {
  console.log('\n正在关闭...');
  scraper.stop();
  await scraper.closeBrowser();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  scraper.stop();
  await scraper.closeBrowser();
  process.exit(0);
});

module.exports = app;
