/**
 * Service Worker - 消息中转 + 数据存储 + 状态管理
 */

// 采集状态
let state = {
  status: 'idle', // idle, running, paused, completed, captcha
  current: 0,
  total: 0,
  success: 0,
  failed: 0,
  message: '',
};

// 监听来自 content script 的消息，转发给 popup/sidepanel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'progress':
      state = { ...state, ...msg };
      broadcastToPopup({ type: 'progress', ...msg });
      saveState();
      break;

    case 'data':
      // 保存数据到 storage
      saveData(msg.item, msg.index);
      broadcastToPopup({ type: 'data', item: msg.item, index: msg.index });
      break;

    case 'captcha':
      state.status = 'captcha';
      state.message = '检测到人机验证，请在页面中手动完成验证后重新开始';
      broadcastToPopup({ type: 'progress', ...state });
      saveState();
      break;

    case 'start':
      // Forward to content script in active tab
      forwardToContent(msg);
      sendResponse({ ok: true });
      break;

    case 'stop':
      forwardToContent(msg);
      sendResponse({ ok: true });
      break;

    case 'getStatus':
      sendResponse(state);
      break;

    case 'getData':
      getAllData().then(data => sendResponse({ data }));
      return true; // async response

    case 'clearData':
      clearData().then(() => {
        state = { status: 'idle', current: 0, total: 0, success: 0, failed: 0, message: '' };
        saveState();
        broadcastToPopup({ type: 'progress', ...state });
        sendResponse({ ok: true });
      });
      return true; // async response
  }
});

/**
 * 转发消息到当前活跃 tab 的 content script
 */
async function forwardToContent(msg) {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id) {
      chrome.tabs.sendMessage(tab.id, msg);
    }
  } catch (e) {
    console.error('Forward to content failed:', e);
  }
}

/**
 * 广播消息给所有 popup/sidepanel
 */
function broadcastToPopup(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {
    // No listeners, ignore
  });
}

/**
 * 保存一条数据
 */
async function saveData(item, index) {
  const result = await chrome.storage.local.get(['scraper_data']);
  const data = result.scraper_data || [];
  // 避免重复（按 index 检查）
  if (!data.find(d => d.name === item.name && d.address === item.address)) {
    data.push(item);
    await chrome.storage.local.set({ scraper_data: data });
  }
}

/**
 * 获取所有数据
 */
async function getAllData() {
  const result = await chrome.storage.local.get(['scraper_data']);
  return result.scraper_data || [];
}

/**
 * 清除数据
 */
async function clearData() {
  await chrome.storage.local.remove(['scraper_data']);
}

/**
 * 保存状态
 */
async function saveState() {
  await chrome.storage.local.set({ scraper_state: state });
}

/**
 * 启动时恢复状态
 */
chrome.storage.local.get(['scraper_state']).then(result => {
  if (result.scraper_state) {
    state = result.scraper_state;
  }
});
