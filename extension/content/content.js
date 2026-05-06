/**
 * Google Maps 数据采集 - Content Script v2
 * 注入到 Google Maps 页面中执行采集逻辑
 * 
 * 修复：
 * 1. waitForDetail Promise bug - 不再首次失败就 resolve
 * 2. 增加等待搜索结果列表初始渲染
 * 3. 更健壮的选择器 + 多级 fallback
 * 4. 更好的滚动加载逻辑
 * 5. 详细的调试日志
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__mapScraperInjected) return;
  window.__mapScraperInjected = true;

  const LOG_PREFIX = '[Maps Scraper]';
  console.log(`${LOG_PREFIX} Content script v2 已注入`);

  // === 多级选择器（增加兼容性）===
  const SEL = {
    results: {
      // 搜索结果列表面板
      panel: 'div[role="feed"]',
      panelFallback: 'div.m6QErb',
      // 搜索结果卡片 - 主选择器
      card: 'div.Nv2PK',
      cardFallback: 'div[jsaction*="mouseover"]',
      // 结束标记
      endOfList: 'div[aria-label*="End of results"], div[aria-label*="end"], p.fontBodyMedium:last-child',
    },
    detail: {
      // 商家名称
      name: 'h1.DUwDvf',
      nameFallback: ['h1.fontHeadlineLarge', 'h1[class*="fontHeadline"]', 'div[role="main"] h1'],
      // 评分
      rating: 'div.F7nice > span:first-child',
      ratingFallback: ['span.BFQ3Mc', 'div[role="main"] span[role="img"]', 'div[aria-label*="star"]'],
      // 评论数
      reviewCount: 'span[aria-label*="review"]',
      reviewCountFallback: ['button[aria-label*="review"] span', 'span[aria-label*="Review"]'],
      // 地址
      address: 'button[data-item-id="address"]',
      addressFallback: ['button[data-item-id^="address"]', 'button[aria-label*="Address"]', 'button[aria-label*="address"]'],
      // 电话
      phone: 'button[data-item-id^="phone"]',
      phoneFallback: ['button[data-item-id="phone:"]', 'button[aria-label*="Phone"]', 'button[aria-label*="phone"]'],
      // 网站
      website: 'a[data-item-id="authority"]',
      websiteFallback: ['a[data-tooltip*="website"]', 'a[data-item-id^="authority"]', 'a[href*="website"]'],
    },
    page: {
      closeDetail: 'button[aria-label*="Back"]',
      closeDetailFallback: 'button[aria-label*="back"]',
      captcha: 'iframe[src*="recaptcha"], div[aria-label*="verify"], form[action*="recaptcha"]',
    },
  };

  // === 状态 ===
  let isRunning = false;
  let abortFlag = false;
  let maxResults = 50;

  // === 工具函数 ===
  function log(...args) {
    console.log(LOG_PREFIX, ...args);
  }

  function randomDelay(min, max) {
    const ms = Math.random() * (max - min) + min;
    return new Promise(r => setTimeout(r, ms));
  }

  /**
   * 增强版 querySelector - 支持多级 fallback
   */
  function q(sel, fallback) {
    const el = document.querySelector(sel);
    if (el) return el;
    if (!fallback) return null;
    if (Array.isArray(fallback)) {
      for (const f of fallback) {
        const e = document.querySelector(f);
        if (e) return e;
      }
    } else {
      return document.querySelector(fallback);
    }
    return null;
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

  // === 等待搜索结果面板出现 ===
  function waitForResultsPanel(timeout = 15000) {
    return new Promise((resolve) => {
      log('等待搜索结果面板加载...');
      const check = () => {
        const panel = document.querySelector(SEL.results.panel) || document.querySelector(SEL.results.panelFallback);
        if (panel) {
          log('搜索结果面板已找到');
          resolve(true);
          return true;
        }
        return false;
      };

      if (check()) return;

      let elapsed = 0;
      const interval = 500;
      const timer = setInterval(() => {
        elapsed += interval;
        if (check()) {
          clearInterval(timer);
          return;
        }
        if (elapsed >= timeout) {
          clearInterval(timer);
          log('等待搜索结果面板超时');
          resolve(false);
        }
      }, interval);
    });
  }

  // === 等待至少有 1 个卡片出现 ===
  function waitForAtLeastOneCard(timeout = 10000) {
    return new Promise((resolve) => {
      log('等待搜索结果卡片出现...');
      const check = () => {
        const count = document.querySelectorAll(SEL.results.card).length;
        const fbCount = document.querySelectorAll(SEL.results.cardFallback).length;
        if (count > 0 || fbCount > 0) {
          log(`找到 ${count} 个卡片 (${fbCount} fallback)`);
          resolve(count > 0 ? count : fbCount);
          return true;
        }
        return false;
      };

      if (check()) return;

      let elapsed = 0;
      const interval = 500;
      const timer = setInterval(() => {
        elapsed += interval;
        if (check()) {
          clearInterval(timer);
          return;
        }
        if (elapsed >= timeout) {
          clearInterval(timer);
          log('等待卡片超时，当前 0 个');
          resolve(0);
        }
      }, interval);
    });
  }

  // === 核心逻辑 ===

  /**
   * 从详情面板提取所有数据
   */
  function extractDetail() {
    const nameEl = q(SEL.detail.name, SEL.detail.nameFallback);
    const name = nameEl ? nameEl.textContent.trim() : '';

    log(`extractDetail: name="${name}"`);

    if (!name) {
      log('extractDetail: 无商家名称，跳过');
      return null;
    }

    // 评分
    const ratingEl = q(SEL.detail.rating, SEL.detail.ratingFallback);
    let rating = '';
    if (ratingEl) {
      const text = ratingEl.textContent.trim();
      const m = text.match(/(\d+\.?\d*)/);
      rating = m ? m[1] : '';
    }

    // 评论数
    const reviewEl = q(SEL.detail.reviewCount, SEL.detail.reviewCountFallback);
    let reviews = '0';
    if (reviewEl) {
      // 尝试从 aria-label 获取
      const aria = reviewEl.getAttribute('aria-label') || '';
      const m = aria.match(/(\d[\d,]*)\s*review/i);
      if (m) {
        reviews = m[1].replace(/,/g, '');
      } else {
        // 尝试从文本获取
        const text = reviewEl.textContent.trim();
        const m2 = text.match(/(\d[\d,]*)/);
        if (m2) reviews = m2[1].replace(/,/g, '');
      }
    }

    // 地址
    const addressBtn = q(SEL.detail.address, SEL.detail.addressFallback);
    const address = getBtnText(addressBtn).replace(/^地址[\s:]*/, '').replace(/^Address[\s:]*/i, '');

    // 电话
    const phoneBtn = q(SEL.detail.phone, SEL.detail.phoneFallback);
    const phone = getBtnText(phoneBtn).replace(/^电话[\s:]*/, '').replace(/^Phone[\s:]*/i, '');

    // 网站
    const websiteEl = q(SEL.detail.website, SEL.detail.websiteFallback);
    const website = websiteEl ? websiteEl.href : '';

    log(`extractDetail: rating="${rating}", reviews="${reviews}", address="${address ? address.substring(0, 30) + '...' : ''}", phone="${phone}", website="${website ? 'yes' : 'no'}"`);

    return { name, rating, reviews, address, phone, website };
  }

  function hasCaptcha() {
    return !!document.querySelector(SEL.page.captcha);
  }

  /**
   * 返回列表视图并等待列表恢复
   */
  async function goBackToListAndWait(timeout = 8000) {
    const backBtn = q(SEL.page.closeDetail, SEL.page.closeDetailFallback);
    if (!backBtn) {
      log('goBackToList: 未找到返回按钮，可能已经在列表视图');
      return true;
    }
    backBtn.click();
    log('goBackToList: 已点击返回，等待列表恢复...');

    // 等待搜索结果面板重新出现（说明已返回列表视图）
    return waitForResultsPanel(timeout);
  }

  /**
   * 滚动加载更多结果
   */
  async function loadMoreResults(target) {
    const cardSel = SEL.results.card;

    let prevCount = 0;
    let noChange = 0;

    for (let attempt = 0; attempt < 30; attempt++) {
      const currentCount = document.querySelectorAll(cardSel).length;

      if (currentCount >= target) {
        log(`已加载足够结果: ${currentCount} >= ${target}`);
        break;
      }

      // 找到 feed 面板并滚动到底部
      const panel = document.querySelector(SEL.results.panel);
      if (panel) {
        // 滚动到面板底部
        const panelRect = panel.getBoundingClientRect();
        panel.scrollIntoView({ behavior: 'smooth', block: 'end' });
        await randomDelay(300, 600);
        // 额外向下滚动一点
        window.scrollBy({ top: 800, behavior: 'smooth' });
      } else {
        window.scrollBy({ top: 1000, behavior: 'instant' });
      }

      // 等待新内容加载
      await randomDelay(2000, 3500);

      const newCount = document.querySelectorAll(cardSel).length;
      log(`滚动 attempt ${attempt}: ${currentCount} -> ${newCount} (target: ${target})`);

      if (newCount === prevCount) {
        noChange++;
        // 检查是否到了列表末尾
        const endEl = q(SEL.results.endOfList);
        if ((endEl && noChange >= 2) || noChange >= 6) {
          log(`到底了: noChange=${noChange}, endEl=${!!endEl}, 当前 ${newCount} 条`);
          break;
        }
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

    const finalCount = document.querySelectorAll(cardSel).length;
    log(`滚动完成，共 ${finalCount} 条结果`);
    return true;
  }

  /**
   * 等待详情面板数据加载完成（修复版 - 不会提前 resolve）
   */
  function waitForDetail(timeout = 12000) {
    return new Promise((resolve) => {
      let resolved = false;
      const nameSel = SEL.detail.name;
      const nameFallback = SEL.detail.nameFallback;

      const check = () => {
        const el = document.querySelector(nameSel) || q(nameSel, nameFallback);
        if (el && el.textContent.trim().length > 0) {
          return true;
        }
        return false;
      };

      // 先立即检查一次
      if (check()) {
        log('waitForDetail: 详情已就绪（即时）');
        resolve(true);
        return;
      }

      // 轮询检查
      let elapsed = 0;
      const interval = 400;
      const timer = setInterval(() => {
        elapsed += interval;

        if (resolved) return; // 已解决，不再检查

        if (check()) {
          resolved = true;
          clearInterval(timer);
          log(`waitForDetail: 详情已就绪 (${elapsed}ms)`);
          resolve(true);
          return;
        }

        if (elapsed >= timeout) {
          resolved = true;
          clearInterval(timer);
          log(`waitForDetail: 等待超时 (${timeout}ms)`);
          resolve(false);
        }
      }, interval);
    });
  }

  /**
   * 主采集流程
   */
  async function startScraper(targetCount) {
    if (isRunning) {
      log('采集已在运行中');
      return;
    }
    isRunning = true;
    abortFlag = false;
    maxResults = targetCount;

    let success = 0;
    let failed = 0;

    log(`启动采集，目标: ${targetCount} 条`);
    send('progress', {
      status: 'running',
      current: 0,
      total: 0,
      success: 0,
      failed: 0,
      message: '等待搜索结果加载...',
    });

    // 第一步：等待搜索结果面板出现
    const panelReady = await waitForResultsPanel(15000);
    if (!panelReady || abortFlag) {
      send('progress', {
        status: 'completed',
        current: 0, total: 0, success: 0, failed: 0,
        message: '未找到搜索结果面板，请确保已在 Google Maps 搜索了关键词',
      });
      isRunning = false;
      return;
    }

    // 第二步：等待至少一个卡片出现
    const initialCards = await waitForAtLeastOneCard(10000);
    if (initialCards === 0 || abortFlag) {
      send('progress', {
        status: 'completed',
        current: 0, total: 0, success: 0, failed: 0,
        message: '搜索结果为空，请尝试其他搜索关键词',
      });
      isRunning = false;
      return;
    }

    log(`初始找到 ${initialCards} 个卡片，开始滚动加载...`);
    send('progress', {
      status: 'running',
      current: 0, total: 0, success: 0, failed: 0,
      message: '开始滚动加载搜索结果...',
    });

    // 第三步：滚动加载更多结果
    const ok = await loadMoreResults(targetCount);
    if (!ok) {
      isRunning = false;
      return;
    }

    const cards = document.querySelectorAll(SEL.results.card);
    const limit = Math.min(cards.length, targetCount);

    log(`滚动完成，共 ${cards.length} 个卡片，将采集 ${limit} 条`);
    send('progress', {
      status: 'running',
      current: 0,
      total: limit,
      success: 0,
      failed: 0,
      message: `找到 ${cards.length} 条结果，开始逐条采集...`,
    });

    if (limit === 0) {
      send('progress', {
        status: 'completed',
        current: 0, total: 0, success: 0, failed: 0,
        message: '未找到搜索结果卡片，选择器可能需要更新',
      });
      isRunning = false;
      return;
    }

    // 第四步：逐条点击采集
    for (let i = 0; i < limit; i++) {
      if (abortFlag) {
        send('progress', {
          status: 'paused',
          current: i, total: limit, success, failed,
          message: '采集已暂停',
        });
        isRunning = false;
        return;
      }

      try {
        send('progress', {
          status: 'running',
          current: i + 1, total: limit, success, failed,
          message: `正在采集第 ${i + 1}/${limit} 条...`,
        });

        // 重新获取卡片（DOM 可能已更新）
        const freshCards = document.querySelectorAll(SEL.results.card);
        if (i >= freshCards.length) {
          log(`第 ${i + 1} 条: 卡片索引超出范围 (${freshCards.length})`);
          failed++;
          continue;
        }

        // 滚动到卡片可见
        freshCards[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
        await randomDelay(800, 1500);

        // 检查验证码
        if (hasCaptcha()) {
          send('captcha', {});
          isRunning = false;
          return;
        }

        // 点击卡片
        log(`点击第 ${i + 1} 个卡片`);
        freshCards[i].click();
        await randomDelay(2000, 3500);

        // 等待详情加载（增加超时到 12 秒）
        const detailReady = await waitForDetail(12000);

        if (hasCaptcha()) {
          send('captcha', {});
          isRunning = false;
          return;
        }

        if (!detailReady) {
          log(`第 ${i + 1} 条: 详情加载超时，跳过本条`);
          failed++;
          await goBackToListAndWait();
          await randomDelay(2000, 3000);
          continue;
        }

        // 提取数据（仅在详情正确加载后）
        const data = extractDetail();
        if (data && data.name) {
          send('data', { item: data, index: i });
          success++;
          log(`✅ 第 ${i + 1} 条: ${data.name}`);
        } else {
          failed++;
          log(`❌ 第 ${i + 1} 条: 提取失败`);
        }

        send('progress', {
          status: 'running',
          current: i + 1, total: limit, success, failed,
          message: `已采集 ${success} 条，失败 ${failed} 条`,
        });

        // 返回列表并等待列表恢复
        await goBackToListAndWait();
        await randomDelay(1000, 2000);

      } catch (err) {
        failed++;
        log(`❌ 第 ${i + 1} 条异常: ${err.message}`);
        send('progress', {
          status: 'running',
          current: i + 1, total: limit, success, failed,
          message: `第 ${i + 1} 条采集失败: ${err.message}`,
        });

        try { await goBackToListAndWait(); } catch (e) { /* ignore */ }
        await randomDelay(2000, 4000);
      }
    }

    send('progress', {
      status: 'completed',
      current: limit, total: limit, success, failed,
      message: `采集完成！成功 ${success} 条，失败 ${failed} 条`,
    });

    log(`采集完成: ${success} 成功, ${failed} 失败`);
    isRunning = false;
  }

  function stopScraper() {
    abortFlag = true;
    log('收到停止指令');
  }

  // === 消息监听 ===
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'start':
        log(`收到采集指令, 目标数量: ${msg.maxResults}`);
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
        log('pong');
        sendResponse({ alive: true });
        break;
      case 'test':
        // 调试测试：返回当前页面选择器匹配情况
        const testResult = {
          panel: !!document.querySelector(SEL.results.panel),
          cards: document.querySelectorAll(SEL.results.card).length,
          cardsFallback: document.querySelectorAll(SEL.results.cardFallback).length,
        };
        sendResponse(testResult);
        break;
    }
    return true; // 保持异步通道
  });

  // 通知 background/content script 已就绪
  chrome.runtime.sendMessage({ type: 'contentReady' }).catch(() => {});
  log('已就绪，等待指令...');
})();
