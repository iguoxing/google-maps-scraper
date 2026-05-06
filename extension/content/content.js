/**
 * Google Maps 数据采集 - Content Script v3
 * 注入到 Google Maps 页面中执行采集逻辑
 *
 * 核心改动（v3）：
 * 1. extractDetail 全面改用 aria-label 策略提取数据（Google Maps 无障碍标注最稳定）
 * 2. 不再依赖 data-item-id 和混淆 CSS 类名（频繁变更）
 * 3. 增加详细的诊断日志
 * 4. 详情面板加载用 waitForKeyElement 等待关键按钮出现
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__mapScraperInjected) return;
  window.__mapScraperInjected = true;

  const LOG_PREFIX = '[Maps Scraper]';
  console.log(LOG_PREFIX + ' Content script v3 已注入 (aria-label 策略)');

  // === 选择器配置 ===
  // Google Maps 频繁更改 CSS 类名（混淆名），但 aria-label 是无障碍标准，最稳定
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
      // === 商家名称 ===
      // h1.DUwDvf 是当前已知的主选择器，但 h1 作为 fallback
      name: 'h1.DUwDvf',
      nameFallback: [
        'h1.fontHeadlineLarge',
        'h1[class*="fontHeadline"]',
        'div[role="main"] h1',
        'h1.lANesb',
        'div[class*="PIoX8"] h1',
        '.SIpiFc h1',
        'h1'
      ],
      // === 评分 ===
      // 最稳定方案：aria-label 包含 " stars"，如 "4.5 stars"
      // 同时用 Google 内部属性 role="img" 的 span 元素
      rating: '[aria-label*=" stars"]',
      ratingFallback: [
        'span[role="img"][aria-label]',
        'div.F7nice > span:first-child',
        'span.BFQ3Mc',
        'div[aria-label*="star"]',
        'span.MW4etd',
        'div.eK4R0e',
        'span.Aq14fc'
      ],
      // === 评论数 ===
      // 最稳定方案：aria-label 包含 " reviews"，如 "123 reviews"
      reviewCount: '[aria-label*=" reviews"]',
      reviewCountFallback: [
        'button[aria-label*="review" i] span',
        'span[aria-label*="Review" i]',
        'span.FhRost',
        'a[href*="reviews"] span',
        'div.jANrlb'
      ],
      // === 地址 ===
      // 最稳定方案：aria-label 包含 "Address:"，如 "Address: 123 Main St, City"
      // 注意 Google 用英文 "Address:"，即使在中文界面
      address: '[aria-label*="Address:"]',
      addressFallback: [
        'button[data-item-id^="address"]',
        'button[aria-label*="地址"]',
        'button[data-item-id="address"]',
        'div[class*="o0Svte"] button',
        'button[class*="CsEnBe"][data-item-id]'
      ],
      // === 电话 ===
      // 最稳定方案：aria-label 包含 "Phone:"，如 "Phone: +1 234-567-8900"
      phone: '[aria-label*="Phone:"]',
      phoneFallback: [
        'button[data-item-id^="phone"]',
        'button[data-item-id="phone:"]',
        'button[aria-label*="电话"]',
        'button[class*="CsEnBe"][data-item-id^="phone"]'
      ],
      // === 网站 ===
      // 最稳定方案：aria-label 包含 "Website:"，如 "Website: example.com"
      // 或 data-item-id 包含 "authority"
      website: '[aria-label*="Website:"]',
      websiteFallback: [
        'a[data-item-id="authority"]',
        'a[data-item-id^="authority"]',
        'a[data-tooltip*="website" i]',
        'a[href*="website"]',
        'a[class*="CsEnBe"][data-item-id]',
        'a[aria-label*="website" i]'
      ],
      // === 加载完成标志 ===
      // 等待这些元素出现表示详情面板已完全加载
      loadedIndicator: 'button[aria-label*="reviewlegaldisclosure"]',
      loadedIndicatorFallback: [
        'button[data-item-id*="reviewlegaldisclosure"]',
        'button[jsaction*="reviewlegaldisclosure"]',
        '[aria-label*="Suggest an edit"]',
        'button[aria-label*="Save"]',
        '[aria-label*="Share"]',
        '[aria-label*="Directions"]'
      ],
    },
    page: {
      closeDetail: 'button[aria-label*="Back" i]',
      closeDetailFallback: 'button[aria-label*="back" i]',
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
    if (!sel) return null;
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
   * 用一组选择器找到第一个匹配的元素
   */
  function findFirst(selectors) {
    for (const s of selectors) {
      try {
        const el = document.querySelector(s);
        if (el) return el;
      } catch (e) { /* invalid selector, skip */ }
    }
    return null;
  }

  /**
   * 从详情面板提取所有数据
   * v3 核心策略：优先使用 aria-label 属性提取数据（最稳定）
   *
   * Google Maps 无障碍标注格式（英文界面）：
   * - 地址按钮 aria-label: "Address: 123 Main St, City"
   * - 电话按钮 aria-label: "Phone: +1 234-567-8900"
   * - 网站按钮 aria-label: "Website: example.com"
   * - 评分 span aria-label: "4.5 stars"
   * - 评论数 span aria-label: "123 reviews"
   *
   * 中文界面：
   * - 地址按钮 aria-label: "地址：xxx" 或 "Address: xxx"
   * - 电话按钮 aria-label: "电话：xxx" 或 "Phone: xxx"
   */
  function extractDetail() {
    log('extractDetail: ========== 开始提取数据 =========');

    // ========= 诊断：打印所有相关 aria-label =========
    var allAria = document.querySelectorAll('[aria-label]');
    log('extractDetail: 页面共有 ' + allAria.length + ' 个带 aria-label 的元素');
    for (var di = 0; di < allAria.length; di++) {
      var del = allAria[di];
      var da = del.getAttribute('aria-label') || '';
      if (da && da.length > 0 && da.length < 300) {
        var tag = del.tagName || '?';
        var id = del.getAttribute('data-item-id') || '';
        log('  [aria-label] <' + tag + '> aria="' + da + '"' + (id ? ' data-item-id="' + id + '"' : ''));
      }
    }
    // 同时也打印所有 button 和 a 标签的 aria-label
    var allBtns = document.querySelectorAll('button[aria-label], a[aria-label]');
    log('extractDetail: 共 ' + allBtns.length + ' 个 button/a 带 aria-label');
    // ========= 诊断结束 =========

    // ======== 商家名称 ========
    var nameEl = findFirst([SEL.detail.name].concat(SEL.detail.nameFallback));
    var name = nameEl ? nameEl.textContent.trim() : '';

    log('extractDetail: name="' + name + '"');

    if (!name || name.length === 0) {
      log('extractDetail: 无商家名称，跳过');
      var allH1 = document.querySelectorAll('h1');
      log('extractDetail: 页面有 ' + allH1.length + ' 个 h1 元素');
      for (var hi = 0; hi < allH1.length; hi++) {
        var h = allH1[hi];
        log('  h1[' + hi + ']: class="' + h.className + '", text="' + h.textContent.trim().substring(0, 50) + '"');
      }
      return null;
    }

    // 过滤掉无效名称
    if (name === 'Google Maps' || name === '地图' || name === 'Maps') {
      log('extractDetail: 名称无效（"' + name + '"），跳过');
      return null;
    }

    // ======== 评分 ========
    var rating = '';
    var ratingEl = findFirst([SEL.detail.rating].concat(SEL.detail.ratingFallback));
    if (ratingEl) {
      var ratingAria = ratingEl.getAttribute('aria-label') || '';
      var ratingText = ratingEl.textContent.trim();
      log('extractDetail: rating aria-label="' + ratingAria + '", text="' + ratingText + '"');

      // 从 aria-label 提取（如 "4.5 stars" → "4.5"）
      var ratingMatch = ratingAria.match(/(\d+\.?\d*)\s*star/i);
      if (ratingMatch) {
        rating = ratingMatch[1];
      } else {
        // 从 textContent 提取
        var ratingMatch2 = ratingText.match(/(\d+\.?\d*)/);
        if (ratingMatch2) rating = ratingMatch2[1];
      }
    }
    log('extractDetail: rating="' + rating + '"');

    // ======== 评论数 ========
    var reviews = '0';
    var reviewEl = findFirst([SEL.detail.reviewCount].concat(SEL.detail.reviewCountFallback));
    if (reviewEl) {
      var reviewAria = reviewEl.getAttribute('aria-label') || '';
      var reviewParentAria = reviewEl.parentElement ? (reviewEl.parentElement.getAttribute('aria-label') || '') : '';
      var reviewText = reviewEl.textContent.trim();
      log('extractDetail: review aria-label="' + reviewAria + '", parent-aria="' + reviewParentAria + '", text="' + reviewText + '"');

      // 从 aria-label 提取（如 "123 reviews" → "123"）
      var reviewMatch = reviewAria.match(/([\d,]+)\s*review/i);
      if (reviewMatch) {
        reviews = reviewMatch[1].replace(/,/g, '');
      } else {
        // 尝试从父元素 aria-label
        reviewMatch = reviewParentAria.match(/([\d,]+)\s*review/i);
        if (reviewMatch) {
          reviews = reviewMatch[1].replace(/,/g, '');
        } else {
          // 从 textContent 提取数字
          reviewMatch = reviewText.match(/([\d,]+)/);
          if (reviewMatch) reviews = reviewMatch[1].replace(/,/g, '');
        }
      }
    }
    log('extractDetail: reviews="' + reviews + '"');

    // ======== 地址 ========
    var address = '';
    var addressEl = findFirst([SEL.detail.address].concat(SEL.detail.addressFallback));
    if (addressEl) {
      var addressAria = addressEl.getAttribute('aria-label') || '';
      var addressText = addressEl.textContent.trim();
      log('extractDetail: address aria-label="' + addressAria + '", text="' + addressText + '"');

      // 从 aria-label 提取，去掉前缀 "Address: " 或 "地址："
      if (addressAria) {
        address = addressAria
          .replace(/^Address:\s*/i, '')
          .replace(/^地址[\uFF1A:]\s*/, '')
          .trim();
      }
      // 如果 aria-label 没有有效地址，尝试从按钮内部文本提取
      if (!address && addressText) {
        address = getBtnText(addressEl)
          .replace(/^Address:\s*/i, '')
          .replace(/^地址[\uFF1A:]\s*/, '')
          .trim();
      }
    }
    log('extractDetail: address="' + address.substring(0, 50) + '"');

    // ======== 电话 ========
    var phone = '';
    var phoneEl = findFirst([SEL.detail.phone].concat(SEL.detail.phoneFallback));
    if (phoneEl) {
      var phoneAria = phoneEl.getAttribute('aria-label') || '';
      var phoneText = phoneEl.textContent.trim();
      log('extractDetail: phone aria-label="' + phoneAria + '", text="' + phoneText + '"');

      // 从 aria-label 提取，去掉前缀 "Phone: " 或 "电话："
      if (phoneAria) {
        phone = phoneAria
          .replace(/^Phone:\s*/i, '')
          .replace(/^电话[\uFF1A:]\s*/, '')
          .trim();
      }
      // 如果 aria-label 没有有效电话，尝试从按钮内部文本提取
      if (!phone && phoneText) {
        phone = getBtnText(phoneEl)
          .replace(/^Phone:\s*/i, '')
          .replace(/^电话[\uFF1A:]\s*/, '')
          .trim();
      }
    }
    log('extractDetail: phone="' + phone + '"');

    // ======== 网站 ========
    var website = '';
    var websiteEl = findFirst([SEL.detail.website].concat(SEL.detail.websiteFallback));
    if (websiteEl) {
      var websiteAria = websiteEl.getAttribute('aria-label') || '';
      var websiteHref = websiteEl.href || '';
      log('extractDetail: website aria-label="' + websiteAria + '", href="' + websiteHref + '"');

      // 从 aria-label 提取 URL，格式如 "Website: example.com"
      if (websiteAria) {
        var websiteUrl = websiteAria
          .replace(/^Website:\s*/i, '')
          .replace(/^网站[\uFF1A:]\s*/, '')
          .trim();
        // 如果提取到的是有效 URL，使用它
        if (websiteUrl && (websiteUrl.indexOf('http') === 0 || websiteUrl.indexOf('www.') === 0)) {
          website = websiteUrl;
        } else if (websiteUrl && websiteUrl.indexOf('.') > 0) {
          // 看起来像域名，加上 https://
          website = 'https://' + websiteUrl;
        }
      }
      // 如果 aria-label 没有有效 URL，从 href 获取
      if (!website && websiteHref) {
        // 排除 Google 自己的链接
        if (websiteHref.indexOf('google.com/maps') === -1) {
          website = websiteHref;
        }
      }
      // 如果 href 是 Google 中转链接，尝试获取 data 属性中的实际 URL
      if (!website && websiteEl.getAttribute('data-url')) {
        website = websiteEl.getAttribute('data-url');
      }
    }
    log('extractDetail: website="' + (website ? website.substring(0, 50) : '(none)') + '"');

    // === 汇总日志 ===
    log('extractDetail: 完成 -> name="' + name + '", rating="' + rating + '", reviews="' + reviews + '", address="' + address.substring(0, 30) + '", phone="' + phone + '", website="' + (website ? 'yes' : 'no') + '"');

    return { name: name, rating: rating, reviews: reviews, address: address, phone: phone, website: website };
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

      var prevCount = 0;
      var noChange = 0;

      for (var attempt = 0; attempt < 30; attempt++) {
        var currentCount = document.querySelectorAll(cardSel).length;

        if (currentCount >= target) {
          log('已加载足够结果: ' + currentCount + ' >= ' + target);
          break;
        }

        // 找到 feed 面板并滚动到底部
        var panel = document.querySelector(SEL.results.panel);
        if (panel) {
          // 滚动到面板底部
          panel.scrollIntoView({ behavior: 'smooth', block: 'end' });
          await randomDelay(300, 600);
          // 额外向下滚动一点
          window.scrollBy({ top: 800, behavior: 'smooth' });
        } else {
          window.scrollBy({ top: 1000, behavior: 'instant' });
        }

        // 等待新内容加载
        await randomDelay(2000, 3500);

        var newCount = document.querySelectorAll(cardSel).length;
        log('滚动 attempt ' + attempt + ': ' + currentCount + ' -> ' + newCount + ' (target: ' + target + ')');

        if (newCount === prevCount) {
          noChange++;
          // 检查是否到了列表末尾
          var endEl = q(SEL.results.endOfList);
          if ((endEl && noChange >= 2) || noChange >= 6) {
            log('到底了: noChange=' + noChange + ', endEl=' + !!endEl + ', 当前 ' + newCount + ' 条');
            break;
          }
        } else {
          noChange = 0;
          prevCount = newCount;
        }

        send('progress', {
          status: 'running',
          message: '滚动加载中... 已发现 ' + newCount + ' 条结果',
          loadedCount: newCount,
        });

        if (hasCaptcha()) {
          send('captcha', {});
          return false;
        }
      }

      var finalCount = document.querySelectorAll(cardSel).length;
      log('滚动完成，共 ' + finalCount + ' 条结果');
    return true;
  }

  /**
   * 等待详情面板数据加载完成
   * v3 策略：同时等待两个条件
   * 1. 名称元素出现且稳定（排除 "Google Maps" 等无效值）
   * 2. 至少一个加载指示器出现（如 "Suggest an edit" 按钮）
   */
  function waitForDetail(timeout) {
    if (!timeout) timeout = 15000;
    return new Promise(function (resolve) {
      var resolved = false;

      // 检查详情面板的名称是否有效
      var checkName = function () {
        var el = findFirst([SEL.detail.name].concat(SEL.detail.nameFallback));
        if (!el) return null;
        var text = el.textContent.trim();
        if (text.length === 0) return null;
        if (text === 'Google Maps' || text === '地图' || text === 'Maps') return null;
        return text;
      };

      // 检查详情面板是否加载完成（关键 UI 元素出现）
      var checkLoadedIndicator = function () {
        return findFirst([SEL.detail.loadedIndicator].concat(SEL.detail.loadedIndicatorFallback));
      };

      // 立即检查
      var immediateName = checkName();
      var immediateIndicator = checkLoadedIndicator();
      if (immediateName && immediateIndicator) {
        log('waitForDetail: 详情已就绪（即时）, name="' + immediateName + '"');
        resolved = true;
        resolve(true);
        return;
      }

      // 轮询检查
      var elapsed = 0;
      var interval = 500;
      var stableCount = 0;
      var lastName = '';
      var hadIndicator = false;

      var timer = setInterval(function () {
        elapsed += interval;
        if (resolved) { clearInterval(timer); return; }

        var currentName = checkName();
        var hasIndicator = !!checkLoadedIndicator();

        if (hasIndicator) hadIndicator = true;

        if (currentName) {
          if (currentName === lastName && lastName.length > 0) {
            stableCount++;
          } else {
            stableCount = 0;
            lastName = currentName;
          }

          // 条件：名称稳定 1s（2次）且出现过加载指示器
          if (stableCount >= 2 && (hadIndicator || hasIndicator)) {
            resolved = true;
            clearInterval(timer);
            log('waitForDetail: 详情已就绪 (' + elapsed + 'ms), name="' + currentName + '"');
            resolve(true);
            return;
          }

          // 降级条件：名称稳定 2s（4次），即使没有指示器也认为加载完成
          if (stableCount >= 4) {
            resolved = true;
            clearInterval(timer);
            log('waitForDetail: 详情已就绪（降级，无指示器）(' + elapsed + 'ms), name="' + currentName + '"');
            resolve(true);
            return;
          }
        } else {
          stableCount = 0;
          lastName = '';
        }

        if (elapsed >= timeout) {
          resolved = true;
          clearInterval(timer);
          // 超时但名称已存在，可能还是可以提取
          if (currentName) {
            log('waitForDetail: 等待超时但名称已存在，尝试继续 (' + timeout + 'ms), name="' + currentName + '"');
            resolve(true);
          } else {
            log('waitForDetail: 等待超时 (' + timeout + 'ms)');
            var allH1 = document.querySelectorAll('h1');
            log('  debug: 页面有 ' + allH1.length + ' 个 h1');
            for (var hi = 0; hi < allH1.length; hi++) {
              var h = allH1[hi];
              log('  h1[' + hi + ']: class="' + h.className + '", text="' + h.textContent.trim().substring(0, 30) + '"');
            }
            resolve(false);
          }
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

    var success = 0;
    var failed = 0;

    log('启动采集，目标: ' + targetCount + ' 条');
    send('progress', {
      status: 'running',
      current: 0,
      total: 0,
      success: 0,
      failed: 0,
      message: '等待搜索结果加载...',
    });

    // 第一步：等待搜索结果面板出现
    var panelReady = await waitForResultsPanel(15000);
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
    var initialCards = await waitForAtLeastOneCard(10000);
    if (initialCards === 0 || abortFlag) {
      send('progress', {
        status: 'completed',
        current: 0, total: 0, success: 0, failed: 0,
        message: '搜索结果为空，请尝试其他搜索关键词',
      });
      isRunning = false;
      return;
    }

    log('初始找到 ' + initialCards + ' 个卡片，开始滚动加载...');
    send('progress', {
      status: 'running',
      current: 0, total: 0, success: 0, failed: 0,
      message: '开始滚动加载搜索结果...',
    });

    // 第三步：滚动加载更多结果
    var ok = await loadMoreResults(targetCount);
    if (!ok) {
      isRunning = false;
      return;
    }

    var cards = document.querySelectorAll(SEL.results.card);
    var limit = Math.min(cards.length, targetCount);

    log('滚动完成，共 ' + cards.length + ' 个卡片，将采集 ' + limit + ' 条');
    send('progress', {
      status: 'running',
      current: 0,
      total: limit,
      success: 0,
      failed: 0,
      message: '找到 ' + cards.length + ' 条结果，开始逐条采集...',
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
    var prevDetailName = '';  // 记录上一个详情面板的名称，用于验证
    for (var i = 0; i < limit; i++) {
      if (abortFlag) {
        send('progress', {
          status: 'paused',
          current: i, total: limit, success: success, failed: failed,
          message: '采集已暂停',
        });
        isRunning = false;
        return;
      }

      try {
        send('progress', {
          status: 'running',
          current: i + 1, total: limit, success: success, failed: failed,
          message: '正在采集第 ' + (i + 1) + '/' + limit + ' 条...',
        });

        // 重新获取卡片（DOM 可能已更新）
        var freshCards = document.querySelectorAll(SEL.results.card);
        if (i >= freshCards.length) {
          log('第 ' + (i + 1) + ' 条: 卡片索引超出范围 (' + freshCards.length + ')');
          failed++;
          continue;
        }

        // 提取卡片上的商家名称（用于验证）
        var cardNameEl = freshCards[i].querySelector('.fontHeadlineSmall, .qBF1Pd, [class*="fontHeadline"]');
        var cardName = cardNameEl ? cardNameEl.textContent.trim() : '';

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
        log('点击第 ' + (i + 1) + ' 个卡片 (列表名称: "' + cardName.substring(0, 30) + '")');
        freshCards[i].click();
        await randomDelay(2000, 3500);

        // 等待详情加载（增加超时到 15 秒）
        var detailReady = await waitForDetail(15000);

        if (hasCaptcha()) {
          send('captcha', {});
          isRunning = false;
          return;
        }

        if (!detailReady) {
          log('第 ' + (i + 1) + ' 条: 详情加载超时，跳过本条');
          failed++;
          await goBackToListAndWait();
          await randomDelay(2000, 3000);
          continue;
        }

        // 额外等待：让所有DOM元素（地址、电话、评分等）完全渲染
        await randomDelay(1500, 2500);

        // 提取数据（仅在详情正确加载后）
        var data = extractDetail();
        
        // 验证数据：检查详情面板的名称是否与列表卡片匹配（模糊匹配）
        if (data && data.name) {
          // 检查是否还是上一条的数据（说明详情面板没有更新）
          if (prevDetailName && data.name === prevDetailName && cardName && data.name !== cardName) {
            log('⚠️ 第 ' + (i + 1) + ' 条: 详情面板未更新！详情名称="' + data.name + '", 期望≈"' + cardName + '", 重试...');
            // 再等一下然后重新提取
            await randomDelay(2000, 3000);
            var retryData = extractDetail();
            if (retryData && retryData.name && retryData.name !== prevDetailName) {
              data = retryData;  // 使用重试数据
            } else {
              // 重试也失败了，跳过
              failed++;
              log('❌ 第 ' + (i + 1) + ' 条: 详情面板仍未更新，跳过');
              await goBackToListAndWait();
              await randomDelay(1000, 2000);
              prevDetailName = '';
              continue;
            }
          }
          
          send('data', { item: data, index: i });
          success++;
          prevDetailName = data.name;
          log('✅ 第 ' + (i + 1) + ' 条: ' + data.name);
        } else {
          failed++;
          prevDetailName = '';
          log('❌ 第 ' + (i + 1) + ' 条: 提取失败');
        }

        send('progress', {
          status: 'running',
          current: i + 1, total: limit, success: success, failed: failed,
          message: '已采集 ' + success + ' 条，失败 ' + failed + ' 条',
        });

        // 返回列表并等待列表恢复
        await goBackToListAndWait();
        await randomDelay(1000, 2000);

      } catch (err) {
        failed++;
        log('❌ 第 ' + (i + 1) + ' 条异常: ' + err.message);
        send('progress', {
          status: 'running',
          current: i + 1, total: limit, success: success, failed: failed,
          message: '第 ' + (i + 1) + ' 条采集失败: ' + err.message,
        });

        try { await goBackToListAndWait(); } catch (e) { /* ignore */ }
        await randomDelay(2000, 4000);
      }
    }

    send('progress', {
      status: 'completed',
      current: limit, total: limit, success: success, failed: failed,
      message: '采集完成！成功 ' + success + ' 条，失败 ' + failed + ' 条',
    });

    log('采集完成: ' + success + ' 成功, ' + failed + ' 失败');
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
