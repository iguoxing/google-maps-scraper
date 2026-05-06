/**
 * Side Panel 逻辑 - 数据展示 + 导出
 */

const tableBody = document.getElementById('tableBody');
const dataCount = document.getElementById('dataCount');
const btnExportCSV = document.getElementById('btnExportCSV');
const btnExportExcel = document.getElementById('btnExportExcel');

let allData = [];

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function renderTable(data) {
  allData = data;
  dataCount.textContent = data.length + ' 条';
  btnExportCSV.disabled = data.length === 0;
  btnExportExcel.disabled = data.length === 0;

  if (data.length === 0) {
    tableBody.innerHTML = `<tr class="empty"><td colspan="7">
      <svg fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M20 13V6a2 2 0 00-2-2H6a2 2 0 00-2 2v7m16 0v5a2 2 0 01-2 2H6a2 2 0 01-2-2v-5m16 0h-2.586a1 1 0 00-.707.293l-2.414 2.414a1 1 0 01-.707.293h-3.172a1 1 0 01-.707-.293l-2.414-2.414A1 1 0 006.586 13H4"/></svg>
      <p>暂无数据，请先使用扩展采集</p></td></tr>`;
    return;
  }

  tableBody.innerHTML = data.map((row, i) => {
    const website = row.website
      ? `<a href="${escapeHtml(row.website)}" target="_blank">${escapeHtml(new URL(row.website).hostname)}</a>`
      : '<span style="color:#334155">-</span>';
    return `<tr>
      <td style="color:#475569">${i + 1}</td>
      <td class="name">${escapeHtml(row.name || '')}</td>
      <td class="address" title="${escapeHtml(row.address || '')}">${escapeHtml(row.address || '-')}</td>
      <td class="phone">${escapeHtml(row.phone || '-')}</td>
      <td class="rating">${row.rating || '-'}</td>
      <td class="reviews">${row.reviews || '0'}</td>
      <td class="website">${website}</td>
    </tr>`;
  }).join('');
}

// 加载数据
function loadData() {
  chrome.storage.local.get(['scraper_data'], (result) => {
    renderTable(result.scraper_data || []);
  });
}

loadData();

// 监听数据变化（来自 content script 的采集）
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'data') {
    loadData();
  }
  if (msg.type === 'progress' && msg.status === 'completed') {
    loadData();
  }
});

// 刷新
document.getElementById('btnRefresh').addEventListener('click', loadData);

// 清除
document.getElementById('btnClear').addEventListener('click', () => {
  if (confirm('确定要清除所有已采集的数据吗？')) {
    chrome.runtime.sendMessage({ type: 'clearData' }, () => {
      loadData();
    });
  }
});

// === 导出功能 ===

function doExportCSV() {
  if (allData.length === 0) return;
  const BOM = '\uFEFF';
  const headers = ['商家名称', '地址', '电话', '评分', '评论数', '网站链接'];
  const fields = ['name', 'address', 'phone', 'rating', 'reviews', 'website'];
  let csv = BOM + headers.join(',') + '\n';
  allData.forEach(row => {
    csv += fields.map(f => {
      let v = row[f] || '';
      if (v.includes(',') || v.includes('"') || v.includes('\n')) v = `"${v.replace(/"/g, '""')}"`;
      return v;
    }).join(',') + '\n';
  });
  downloadBlob(csv, `maps-data-${dateStr()}.csv`, 'text/csv;charset=utf-8');
}

async function doExportExcel() {
  if (allData.length === 0) return;
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
  const wsData = [headers, ...allData.map(r => fields.map(f => r[f] || ''))];
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [{ wch: 30 }, { wch: 50 }, { wch: 20 }, { wch: 8 }, { wch: 10 }, { wch: 40 }];
  XLSX.utils.book_append_sheet(wb, ws, 'Google Maps 数据');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  downloadBlob(new Blob([buf], { type: 'application/octet-stream' }), `maps-data-${dateStr()}.xlsx`);
}

function downloadBlob(content, filename, mimeType) {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function dateStr() {
  return new Date().toISOString().slice(0, 10);
}

btnExportCSV.addEventListener('click', doExportCSV);
btnExportExcel.addEventListener('click', doExportExcel);
