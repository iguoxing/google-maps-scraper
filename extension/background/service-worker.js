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

// ========== 数据存储（带互斥锁，防止读写竞态）==========
let dataCache = null;       // 内存缓存，避免反复读磁盘
let dataCacheReady = false;
const dataLock = { locked: false, queue: [] }; // 简单互斥锁

function acquireLock() {
  return new Promise(resolve => {
    if (!dataLock.locked) {
      dataLock.locked = true;
      resolve();
    } else {
      dataLock.queue.push(resolve);
    }
  });
}

function releaseLock() {
  if (dataLock.queue.length > 0) {
    const next = dataLock.queue.shift();
    next();
  } else {
    dataLock.locked = false;
  }
}

// 初始化：启动时从 storage 恢复缓存
chrome.storage.local.get(['scraper_data']).then(result => {
  dataCache = result.scraper_data || [];
  dataCacheReady = true;
  console.log(`[SW] 数据缓存已加载，${dataCache.length} 条`);
});

// ============================================================

// 监听来自 content script 的消息，转发给 popup/sidepanel
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case 'progress':
      state = { ...state, ...msg };
      broadcastToPopup({ type: 'progress', ...msg });
      saveState();
      break;

    case 'data':
      // 保存数据到 storage（加锁，防止竞态）
      handleData(msg.item, msg.index).then(() => {
        broadcastToPopup({ type: 'data', item: msg.item, index: msg.index });
      });
      // 异步处理，不阻塞
      return false;

    case 'captcha':
      state.status = 'captcha';
      state.message = '检测到人机验证，请在页面中手动完成验证后重新开始';
      broadcastToPopup({ type: 'progress', ...state });
      saveState();
      break;

    case 'start':
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
      getData().then(data => sendResponse({ data }));
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
 * 处理数据保存（加锁防止竞态写入）
 */
async function handleData(item, index) {
  await acquireLock();
  try {
    // 确保缓存已加载
    if (!dataCacheReady) {
      const result = await chrome.storage.local.get(['scraper_data']);
      dataCache = result.scraper_data || [];
      dataCacheReady = true;
    }

    // 按 index 存储/覆盖（不依赖 name+address 去重）
    // 补齐数组长度（用 null 占位）
    while (dataCache.length <= index) {
      dataCache.push(null);
    }
    dataCache[index] = item;

    // 持久化
    await chrome.storage.local.set({ scraper_data: dataCache });
    console.log(`[SW] 已保存 index=${index}, name=${item.name}, 总计=${dataCache.filter(Boolean).length} 条有效`);
  } finally {
    releaseLock();
  }
}

/**
 * 获取所有数据（过滤掉 null 占位符）
 */
async function getData() {
  if (!dataCacheReady) {
    const result = await chrome.storage.local.get(['scraper_data']);
    dataCache = result.scraper_data || [];
    dataCacheReady = true;
  }
  // 过滤掉 null（indexOf 占位的空槽）
  return dataCache.filter(Boolean);
}

/**
 * 清除数据
 */
async function clearData() {
  dataCache = [];
  dataCacheReady = true;
  await chrome.storage.local.remove(['scraper_data']);
}

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
 * 保存状态
 */
async function saveState() {
  await chrome.storage.local.set({ scraper_state: state });
}
