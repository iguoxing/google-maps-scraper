/**
 * Popup 逻辑
 */

const $ = id => document.getElementById(id);

const statusDot = $('statusDot');
const statusText = $('statusText');
const pageWarning = $('pageWarning');
const progressSection = $('progressSection');
const progressFill = $('progressFill');
const pCurrent = $('pCurrent');
const pTotal = $('pTotal');
const pSuccess = $('pSuccess');
const pFailed = $('pFailed');
const progressMsg = $('progressMsg');
const btnStart = $('btnStart');
const btnStop = $('btnStop');
const maxResultsInput = $('maxResults');

let isRunning = false;
let collectedCount = 0;
let contentReady = false;

function delay2k() { return new Promise(r => setTimeout(r, 2000)); }

// 初始化
chrome.tabs.query({ active: true, currentWindow: true }, async ([tab]) => {
  if (!tab) return;

  const isMapsPage = tab && tab.url && (tab.url.includes('google.com/maps') || tab.url.includes('google.com.hk/maps') || tab.url.includes('maps.google.com'));
  if (!isMapsPage) {
    pageWarning.style.display = 'flex';
    btnStart.disabled = true;
    statusText.textContent = '请在 Google Maps 页面使用';
    return;
  }

  // 检测 content script 是否已注入
  try {
    const response = await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    if (response && response.alive) {
      contentReady = true;
      statusText.textContent = '就绪';
    }
  } catch (e) {
    // content script 未注入，尝试注入
    statusText.textContent = '正在注入脚本...';
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content/content.js']
      });
      contentReady = true;
      statusText.textContent = '就绪';
    } catch (injectErr) {
      statusText.textContent = '脚本注入失败，请刷新页面';
      btnStart.disabled = true;
      console.error('Injection failed:', injectErr);
    }
  }
});

// 恢复状态
chrome.runtime.sendMessage({ type: 'getStatus' }, (state) => {
  if (state) updateStatus(state);
});
chrome.runtime.sendMessage({ type: 'getData' }, (res) => {
  if (res && res.data) {
    collectedCount = res.data.length;
    updateExportButtons();
  }
});

// 监听消息
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'progress') {
    updateStatus(msg);
  }
  if (msg.type === 'data') {
    collectedCount++;
    updateExportButtons();
  }
});

function updateStatus(s) {
  const status = s.status || 'idle';
  statusDot.className = 'status-dot';
  if (status === 'running') {
    statusDot.classList.add('running');
    statusText.textContent = '采集中...';
  } else if (status === 'completed') {
    statusDot.classList.add('completed');
    statusText.textContent = '采集完成';
  } else if (status === 'captcha') {
    statusDot.classList.add('captcha');
    statusText.textContent = '需要验证';
  } else if (status === 'paused') {
    statusDot.classList.add('paused');
    statusText.textContent = '已暂停';
  } else {
    statusText.textContent = '就绪';
  }

  isRunning = status === 'running';
  btnStart.style.display = isRunning ? 'none' : 'block';
  btnStop.style.display = isRunning ? 'block' : 'none';

  if (s.total > 0 || s.current > 0) {
    progressSection.style.display = 'block';
    pCurrent.textContent = s.current || 0;
    pTotal.textContent = s.total || 0;
    pSuccess.textContent = s.success || 0;
    pFailed.textContent = s.failed || 0;
    const pct = s.total > 0 ? ((s.current || 0) / s.total * 100) : 0;
    progressFill.style.width = pct + '%';
    progressMsg.textContent = s.message || '';
  }
}

function updateExportButtons() {
  $('btnExportCSV').disabled = collectedCount === 0;
  $('btnExportExcel').disabled = collectedCount === 0;
}

// 开始采集
btnStart.addEventListener('click', async () => {
  const maxResults = parseInt(maxResultsInput.value) || 50;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;

    // 先尝试 ping，如果失败则重新注入
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'ping' });
    } catch (e) {
      // content script 不存在，重新注入
      statusText.textContent = '正在注入脚本...';
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content/content.js']
        });
        contentReady = true;
      } catch (injectErr) {
        statusText.textContent = '注入失败，请刷新页面重试';
        console.error('Re-injection failed:', injectErr);
        return;
      }
    }

    chrome.tabs.sendMessage(tab.id, { type: 'start', maxResults }, async (response) => {
      if (chrome.runtime.lastError) {
        statusText.textContent = '连接失败，请刷新页面重试';
        console.error('Send failed:', chrome.runtime.lastError);
        return;
      }
      // 发送后立即做一次诊断检查
      await delay2k();
      try {
        const diag = await chrome.tabs.sendMessage(tab.id, { type: 'test' });
        if (diag && diag.cards === 0 && diag.cardsFallback === 0) {
          statusText.textContent = '⚠️ 未检测到搜索结果，请确认已搜索关键词';
        } else if (diag && !diag.panel) {
          statusText.textContent = '⚠️ 未检测到搜索结果面板，请确认在搜索结果页';
        }
      } catch (e) { /* ignore */ }

      statusDot.className = 'status-dot running';
      if (!statusText.textContent.startsWith('⚠️')) {
        statusText.textContent = '采集已启动...';
      }
      progressSection.style.display = 'block';
      progressMsg.textContent = '正在启动采集...';
    });
  } catch (e) {
    statusText.textContent = '启动失败: ' + e.message;
    console.error('Start failed:', e);
  }
});

// 停止采集
btnStop.addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, { type: 'stop' });
    }
  } catch (e) { /* ignore */ }
});

// 打开 Side Panel
$('btnOpenPanel').addEventListener('click', async () => {
  try {
    await chrome.sidePanel.open({ tabId: (await chrome.tabs.query({ active: true }))[0].id });
  } catch (e) {
    // Fallback: open in new tab
    chrome.tabs.create({ url: chrome.runtime.getURL('sidepanel/sidepanel.html') });
  }
});

// 导出 CSV
$('btnExportCSV').addEventListener('click', async () => {
  const res = await chrome.storage.local.get(['scraper_data']);
  const data = (res.scraper_data || []).filter(Boolean);
  if (data.length === 0) return;

  const BOM = '\uFEFF';
  const headers = ['商家名称', '地址', '电话', '评分', '评论数', '网站链接'];
  const fields = ['name', 'address', 'phone', 'rating', 'reviews', 'website'];
  let csv = BOM + headers.join(',') + '\n';
  data.forEach(row => {
    csv += fields.map(f => {
      let v = row[f] || '';
      if (v.includes(',') || v.includes('"') || v.includes('\n')) v = `"${v.replace(/"/g, '""')}"`;
      return v;
    }).join(',') + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `maps-data-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
});

// 导出 Excel（加载 SheetJS）
$('btnExportExcel').addEventListener('click', async () => {
  const res = await chrome.storage.local.get(['scraper_data']);
  const data = (res.scraper_data || []).filter(Boolean);
  if (data.length === 0) return;

  // 加载 SheetJS
  if (!window.XLSX) {
    await new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js';
      s.onload = resolve;
      s.onerror = reject;
      document.head.appendChild(s);
    });
  }

  const headers = ['商家名称', '地址', '电话', '评分', '评论数', '网站链接'];
  const fields = ['name', 'address', 'phone', 'rating', 'reviews', 'website'];
  const wsData = [headers, ...data.map(r => fields.map(f => r[f] || ''))];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 30 }, { wch: 50 }, { wch: 20 }, { wch: 8 }, { wch: 10 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Google Maps 数据');

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `maps-data-${new Date().toISOString().slice(0, 10)}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
});

// 清除数据
$('btnClear').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clearData' });
  collectedCount = 0;
  updateExportButtons();
  progressSection.style.display = 'none';
  statusDot.className = 'status-dot';
  statusText.textContent = '数据已清除';
});
