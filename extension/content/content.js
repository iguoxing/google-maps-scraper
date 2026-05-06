/**
 * Google Maps 数据采集 - Content Script
 * 注入到 Google Maps 页面中执行采集逻辑
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__mapScraperInjected) return;
  window.__mapScraperInjected = true;

  // === 选择器 ===
  const SEL = {
    results: {
      panel: 'div[role="feed"]',
      card: 'div.Nv2PK',
      cardFallback: 'div[jsaction*="mouseover"]',
      endOfList: 'div[aria-label*="End of results"], div[aria-label*="end"]',
    },
    detail: {
      name: 'h1.DUwDvf',
      nameFallback: 'h1.fontHeadlineLarge',
      rating: 'div.F7nice > span:first-child',
      reviewCount: 'span[aria-label*="review"]',
      reviewCountFallback: 'button[aria-label*="review"] span',
      address: 'button[data-item-id="address"]',
      addressFallback: 'button[aria-label*="Address"]',
      phone: 'button[data-item-id^="phone"]',
      phoneFallback: 'button[aria-label*="Phone"]',
      website: 'a[data-item-id="authority"]',
      websiteFallback: 'a[data-tooltip*="website"]',
    },
    page: {
      closeDetail: 'button[aria-label*="Back"]',
      captcha: 'iframe[src*="recaptcha"], div[aria-label*="verify"], form[action*="recaptcha"]',
    },
  };

  // === 状态 ===
  let isRunning = false;
  let abortFlag = false;
  let maxResults = 50;

  // === 工具函数 ===
  function randomDelay(min, max) {
    return new Promise(r => setTimeout(r, Math.random() * (max - min) + min));
  }

  function q(sel, fallback) {
    return document.querySelector(sel) || (fallback ? document.querySelector(fallback) : null);
  }

  function getBtnText(btn) {
    if (!btn) return '';
    const v = btn.querySelector('.Io6YTe') || btn.querySelector('span');
    return v ? v.textContent.trim() : btn.textContent.trim();
  }

  function send(type, data) {
    try {
      chrome.runtime.sendMessage({ type, ...data });
    } catch (e) {
      // Extension context may be invalidated
    }
  }

  // === 核心逻辑 ===

  function extractDetail() {
    const nameEl = q(SEL.detail.name, SEL.detail.nameFallback);
    const name = nameEl ? nameEl.textContent.trim() : '';
    if (!name) return null;

    const ratingEl = q(SEL.detail.rating);
    let rating = '';
    if (ratingEl) {
      const m = ratingEl.textContent.trim().match(/(\d+\.?\d*)/);
      rating = m ? m[1] : '';
    }

    const reviewEl = q(SEL.detail.reviewCount, SEL.detail.reviewCountFallback);
    let reviews = '0';
    if (reviewEl) {
      const aria = reviewEl.getAttribute('aria-label') || '';
      const m = aria.match(/(\d[\d,]*)\s*review/i);
      reviews = m ? m[1].replace(',', '') : '0';
    }

    const addressBtn = q(SEL.detail.address, SEL.detail.addressFallback);
    const address = getBtnText(addressBtn).replace(/^地址\s*/, '');

    const phoneBtn = q(SEL.detail.phone, SEL.detail.phoneFallback);
    const phone = getBtnText(phoneBtn).replace(/^电话\s*/, '');

    const websiteEl = q(SEL.detail.website, SEL.detail.websiteFallback);
    const website = websiteEl ? websiteEl.href : '';

    return { name, rating, reviews, address, phone, website };
  }

  function hasCaptcha() {
    return !!document.querySelector(SEL.page.captcha);
  }

  function goBackToList() {
    const backBtn = q(SEL.page.closeDetail);
    if (backBtn) {
      backBtn.click();
      return true;
    }
    return false;
  }

  /**
   * 滚动加载更多结果
   */
  async function loadMoreResults(target) {
    let prevCount = 0;
    let noChange = 0;

    for (let attempt = 0; attempt < 20; attempt++) {
      const currentCount = document.querySelectorAll(SEL.results.card).length;
      if (currentCount >= target) break;

      // 滚动
      const panel = document.querySelector(SEL.results.panel);
      if (panel) {
        panel.scrollIntoView({ block: 'end' });
        window.scrollBy(0, 500);
      } else {
        window.scrollBy(0, 800);
      }

      await randomDelay(2000, 4000);

      const newCount = document.querySelectorAll(SEL.results.card).length;
      if (newCount === prevCount) {
        noChange++;
        if (noChange >= 5) break;
        const endEl = q(SEL.results.endOfList);
        if (endEl && noChange >= 3) break;
      } else {
        noChange = 0;
        prevCount = newCount;
      }

      send('progress', {
        status: 'running',
        message: `滚动加载中... 已发现 ${newCount} 条结果`,
        loadedCount: newCount,
      });

      if (hasCaptcha()) {
        send('captcha', {});
        return false;
      }
    }
    return true;
  }

  /**
   * 等待详情面板数据加载完成
   */
  function waitForDetail(timeout = 10000) {
    return new Promise((resolve) => {
      const nameSel = SEL.detail.name;
      const check = () => {
        const el = document.querySelector(nameSel) || document.querySelector(SEL.detail.nameFallback);
        if (el && el.textContent.trim().length > 0) {
          resolve(true);
          return;
        }
        resolve(false);
      };

      // 轮询检查
      let elapsed = 0;
      const interval = 300;
      const timer = setInterval(() => {
        elapsed += interval;
        if (check()) {
          clearInterval(timer);
          resolve(true);
          return;
        }
        if (elapsed >= timeout) {
          clearInterval(timer);
          resolve(false);
        }
      }, interval);
    });
  }

  /**
   * 主采集流程
   */
  async function startScraper(targetCount) {
    if (isRunning) return;
    isRunning = true;
    abortFlag = false;
    maxResults = targetCount;

    let success = 0;
    let failed = 0;

    send('progress', {
      status: 'running',
      current: 0,
      total: 0,
      success: 0,
      failed: 0,
      message: '开始滚动加载搜索结果...',
    });

    // 滚动加载
    const ok = await loadMoreResults(targetCount);
    if (!ok) {
      isRunning = false;
      return;
    }

    const cards = document.querySelectorAll(SEL.results.card);
    const limit = Math.min(cards.length, targetCount);

    send('progress', {
      status: 'running',
      current: 0,
      total: limit,
      success: 0,
      failed: 0,
      message: `找到 ${cards.length} 条结果，开始逐条采集...`,
    });

    for (let i = 0; i < limit; i++) {
      if (abortFlag) {
        send('progress', {
          status: 'paused',
          current: i,
          total: limit,
          success,
          failed,
          message: '采集已暂停',
        });
        isRunning = false;
        return;
      }

      try {
        send('progress', {
          status: 'running',
          current: i + 1,
          total: limit,
          success,
          failed,
          message: `正在采集第 ${i + 1}/${limit} 条...`,
        });

        // 重新获取卡片（DOM 可能已更新）
        const freshCards = document.querySelectorAll(SEL.results.card);
        if (i >= freshCards.length) {
          failed++;
          continue;
        }

        // 滚动到卡片可见
        freshCards[i].scrollIntoViewIfNeeded();
        await randomDelay(500, 1500);

        // 检查验证码
        if (hasCaptcha()) {
          send('captcha', {});
          isRunning = false;
          return;
        }

        // 点击卡片
        freshCards[i].click();
        await randomDelay(2500, 4000);

        // 等待详情加载
        await waitForDetail(8000);

        if (hasCaptcha()) {
          send('captcha', {});
          isRunning = false;
          return;
        }

        // 提取数据
        const data = extractDetail();
        if (data) {
          send('data', { item: data, index: i });
          success++;
        } else {
          failed++;
        }

        send('progress', {
          status: 'running',
          current: i + 1,
          total: limit,
          success,
          failed,
          message: `已采集 ${success} 条，失败 ${failed} 条`,
        });

        // 返回列表
        goBackToList();
        await randomDelay(1500, 3000);
      } catch (err) {
        failed++;
        send('progress', {
          status: 'running',
          current: i + 1,
          total: limit,
          success,
          failed,
          message: `第 ${i + 1} 条采集失败: ${err.message}`,
        });

        try { goBackToList(); } catch (e) { /* ignore */ }
        await randomDelay(2000, 4000);
      }
    }

    send('progress', {
      status: 'completed',
      current: limit,
      total: limit,
      success,
      failed,
      message: `采集完成！成功 ${success} 条，失败 ${failed} 条`,
    });

    isRunning = false;
  }

  function stopScraper() {
    abortFlag = true;
  }

  // === 消息监听 ===
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'start':
        startScraper(msg.maxResults || 50);
        sendResponse({ ok: true });
        break;
      case 'stop':
        stopScraper();
        sendResponse({ ok: true });
        break;
      case 'getStatus':
        sendResponse({ isRunning, abortFlag });
        break;
      case 'ping':
        sendResponse({ alive: true });
        break;
    }
    return true; // 保持异步通道
  });
})();
