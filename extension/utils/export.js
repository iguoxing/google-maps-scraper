/**
 * 数据导出工具（纯前端实现）
 */

/**
 * 导出 CSV
 */
function exportCSV(data, filename) {
  const BOM = '\uFEFF';
  const headers = ['商家名称', '地址', '电话', '评分', '评论数', '网站链接'];
  const fields = ['name', 'address', 'phone', 'rating', 'reviews', 'website'];

  let csv = BOM + headers.join(',') + '\n';
  data.forEach(row => {
    const values = fields.map(field => {
      let val = row[field] || '';
      if (val.includes(',') || val.includes('"') || val.includes('\n')) {
        val = `"${val.replace(/"/g, '""')}"`;
      }
      return val;
    });
    csv += values.join(',') + '\n';
  });

  downloadFile(csv, filename || `maps-data-${today()}.csv`, 'text/csv;charset=utf-8');
}

/**
 * 导出 Excel（使用 SheetJS CDN）
 */
async function exportExcel(data, filename) {
  // 动态加载 SheetJS
  if (!window.XLSX) {
    await loadScript('https://cdn.sheetjs.com/xlsx-0.20.1/package/dist/xlsx.full.min.js');
  }

  const headers = ['商家名称', '地址', '电话', '评分', '评论数', '网站链接'];
  const fields = ['name', 'address', 'phone', 'rating', 'reviews', 'website'];

  const wsData = [headers];
  data.forEach(row => {
    wsData.push(fields.map(f => row[f] || ''));
  });

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws['!cols'] = [
    { wch: 30 }, { wch: 50 }, { wch: 20 }, { wch: 8 }, { wch: 10 }, { wch: 40 },
  ];
  XLSX.utils.book_append_sheet(wb, ws, 'Google Maps 数据');

  const wbout = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  const blob = new Blob([wbout], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || `maps-data-${today()}.xlsx`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

function today() {
  return new Date().toISOString().slice(0, 10);
}
