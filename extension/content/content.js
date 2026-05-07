/**
 * Google Maps 数据采集 - Content Script v8
 * 注入到 Google Maps 页面中执行采集逻辑
 *
 * v8 核心改进：
 * 1. 详情面板定位：在 role="main" 内精确分离详情面板子区域（排除搜索列表 role="feed"）
 * 2. 名称变化检测：使用 MutationObserver 监听详情面板 DOM 变化，确认内容已切换
 * 3. 评分提取优化：限制在详情面板子区域内搜索，排除搜索列表中所有评分元素
 * 4. 去重机制加强：在提取阶段就排除搜索列表卡片内的元素
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__mapScraperInjected) return;
  window.__mapScraperInjected = true;

  const LOG_PREFIX = '[Maps Scraper]';
  console.log(LOG_PREFIX + ' Content script v8 已注入');

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

  function send(type, data) {
    try {
      chrome.runtime.sendMessage({ type, ...data });
    } catch (e) { /* ignore */ }
  }

  function hasCaptcha() {
    return !!document.querySelector('iframe[src*="recaptcha"], div[aria-label*="verify"]');
  }

  /**
   * 在指定容器内用一组选择器找第一个匹配
   */
  function queryFirst(scope, selectors) {
    if (!scope || !selectors) return null;
    if (typeof selectors === 'string') {
      try { return scope.querySelector(selectors); } catch(e) { return null; }
    }
    if (Array.isArray(selectors)) {
      for (const s of selectors) {
        try {
          const el = scope.querySelector(s);
          if (el) return el;
        } catch(e) { /* skip invalid */ }
      }
    }
    return null;
  }

  function getBtnText(btn) {
    if (!btn) return '';
    const v = btn.querySelector('.Io6YTe') || btn.querySelector('span');
    return v ? v.textContent.trim() : btn.textContent.trim();
  }

  // =====================================================
  // 核心功能1：智能查找详情面板容器
  // =====================================================
  /**
   * 智能识别详情面板容器 - v8 重写
   *
   * 核心问题：Google Maps 的 role="main" 同时包含搜索列表 + 详情面板，
   * 如果直接用 role="main" 作为 scope，搜索列表中的商家名/评分也会被采集到，
   * 导致重复数据和错误评分。
   *
   * v8 策略：
   * 1. role="dialog"（可见的弹窗式）→ 直接用
   * 2. aria-modal="true"（可见）→ 直接用
   * 3. role="main" 内通过布局分析分离详情面板：
   *    a) 找到 role="feed"（搜索列表容器）
   *    b) 在 role="main" 内找到【不包含 role="feed"】且【有详情特征】的子容器
   *    c) 如果找不到独立子容器，用关闭/返回按钮向上定位
   * 4. 降级策略
   */
  function findDetailContainer() {
    // 策略1: 可见的弹窗式详情面板 - role="dialog"
    var dialogs = document.querySelectorAll('div[role="dialog"]');
    for (var di = 0; di < dialogs.length; di++) {
      var d = dialogs[di];
      if (d.offsetHeight > 100) {
        log('findDetailContainer: 可见的 role="dialog" (高=' + d.offsetHeight + ')');
        return d;
      }
    }

    // 策略2: aria-modal="true" 可见
    var modals = document.querySelectorAll('[aria-modal="true"]');
    for (var mi = 0; mi < modals.length; mi++) {
      var mo = modals[mi];
      if (mo.offsetHeight > 100) {
        log('findDetailContainer: 可见的 aria-modal (高=' + mo.offsetHeight + ')');
        return mo;
      }
    }

    // 策略3: role="main" 内精确分离详情面板
    var main = document.querySelector('div[role="main"]');
    if (main) {
      var feed = main.querySelector('div[role="feed"]');

      // 3a: 通过关闭/返回按钮定位详情面板子容器（按钮一定在详情面板内）
      var closeSelectors = [
        'button[aria-label="Close"]', 'button[aria-label="close"]',
        'button[aria-label*="关闭"]', 'button[aria-label*="Back"]',
        'button[aria-label*="back"]', 'button[aria-label*="返回"]'
      ];
      for (var ci = 0; ci < closeSelectors.length; ci++) {
        var closeBtn = main.querySelector(closeSelectors[ci]);
        if (closeBtn) {
          // 从关闭按钮向上找容器（最多15层），找宽度>300且不包含feed的
          var parent = closeBtn.parentElement;
          for (var up = 0; up < 15 && parent && parent !== main; up++) {
            if (parent.offsetWidth > 300 && parent.offsetHeight > 200) {
              // 确认这个容器不包含搜索列表（排除feed所在分支）
              if (!parent.contains(feed) || parent === feed) {
                log('findDetailContainer: 通过关闭按钮定位 (宽=' + parent.offsetWidth + ', 高=' + parent.offsetHeight + ')');
                return parent;
              }
            }
            parent = parent.parentElement;
          }
          // 按钮在 main 内但没找到合适容器 → 用 main 但后续提取时排除 feed
          log('findDetailContainer: 关闭按钮在 role="main" 内，使用 role="main"（将排除搜索列表）');
          return main;
        }
      }

      // 3b: 如果没有关闭按钮，通过找 role="main" 内不包含 feed 的子容器
      // Google Maps 的详情面板通常是一个不包含搜索列表的独立 div
      if (feed) {
        // 遍历 main 的直接子元素，找到不包含 feed 的那个（详情面板）
        var mainChildren = main.children;
        for (var mc = 0; mc < mainChildren.length; mc++) {
          var child = mainChildren[mc];
          // 跳过不可见的
          if (child.offsetHeight === 0) continue;
          // 跳过包含 feed 的（搜索列表区域）
          if (child.contains(feed)) continue;
          // 检查是否有详情特征
          var childHasStars = !!child.querySelector('[aria-label*="stars" i]');
          var childHasSave = !!child.querySelector('[aria-label*="Save" i]');
          var childHasShare = !!child.querySelector('[aria-label*="Share" i]');
          var childHasName = !!child.querySelector('.qBF1Pd, [class*="fontHeadlineSmall"], h1.DUwDvf');
          if (child.offsetWidth > 300 && (childHasStars || childHasSave || childHasShare || childHasName)) {
            log('findDetailContainer: main内不包含feed的子容器 (宽=' + child.offsetWidth + ', 高=' + child.offsetHeight + ')');
            return child;
          }
        }

        // 3c: 深入一层，找 feed 的兄弟元素的子树
        if (feed.parentElement && feed.parentElement !== main) {
          var feedParent = feed.parentElement;
          var feedSiblings = feedParent.parentElement ? feedParent.parentElement.children : [];
          for (var fs = 0; fs < feedSiblings.length; fs++) {
            var sibling = feedSiblings[fs];
            if (sibling === feedParent) continue;
            if (sibling.offsetHeight === 0) continue;
            if (sibling.offsetWidth > 300 && sibling.offsetHeight > 200) {
              log('findDetailContainer: feed兄弟元素 (宽=' + sibling.offsetWidth + ', 高=' + sibling.offsetHeight + ')');
              return sibling;
            }
          }
        }
      }

      // 3d: 最后降级到 role="main"
      log('findDetailContainer: 降级使用 role="main"（将排除搜索列表）');
      return main;
    }

    // 策略4: 回退
    log('findDetailContainer: 未找到详情容器，使用 document');
    return null;
  }

  /**
   * 获取排除搜索列表后的精确搜索范围
   * 即使 findDetailContainer() 返回了 role="main"，也要确保提取时排除搜索列表区域
   */
  function getExtractionScope() {
    var container = findDetailContainer();
    if (!container) {
      log('getExtractionScope: 无容器，使用 document');
      return { scope: document, label: 'document' };
    }

    var role = container.getAttribute('role') || '';
    // 如果容器本身就是 dialog 或 modal，直接用
    if (role === 'dialog' || container.hasAttribute('aria-modal')) {
      return { scope: container, label: role };
    }

    // 如果容器是 role="main"，尝试找到其中的详情面板子区域
    if (role === 'main') {
      var feed = container.querySelector('div[role="feed"]');
      if (feed) {
        // 检查容器内是否有不包含 feed 的可见子元素
        var children = container.children;
        for (var i = 0; i < children.length; i++) {
          var child = children[i];
          if (child.offsetHeight === 0) continue;
          if (child === feed || child.contains(feed)) continue;
          if (child.offsetWidth > 300) {
            log('getExtractionScope: main 内隔离子容器');
            return { scope: child, label: 'main-child' };
          }
        }

        // 找不到隔离子容器 → 创建虚拟scope标记，在提取函数中排除 feed
        log('getExtractionScope: main（提取时将排除 feed 区域）');
        return { scope: container, label: 'main-exclude-feed', feedElement: feed };
      }
    }

    return { scope: container, label: role || 'container' };
  }

  /**
   * 判断元素是否在搜索列表区域内
   */
  function isInSearchList(el) {
    if (!el) return false;
    // 直接在搜索卡片内
    if (el.closest && el.closest('div.Nv2PK')) return true;
    // 在搜索列表 feed 内
    if (el.closest && el.closest('div[role="feed"]')) return true;
    // 在搜索列表容器内（常见父容器class）
    if (el.closest && el.closest('div.m6QErb') && !el.closest('div[aria-label*="suggest"]')) return true;
    return false;
  }

  // =====================================================
  // 核心功能2：提取商家数据
  // =====================================================

  /**
   * 从详情面板提取所有数据
   *
   * v5 策略：
   * 1. 名称：多层级提取 + 无效值过滤
   * 2. 评分：aria-label "stars" + 多种 fallback
   * 3. 评论数：aria-label "reviews" + fallback
   * 4. 地址：aria-label "Address:" + data-item-id + fallback
   * 5. 电话：aria-label "Phone:" + data-item-id + fallback
   * 6. 网站：aria-label "Website:" + href + fallback
   */
  function extractDetail() {
    log('extractDetail: ========== 开始提取 ==========');

    var ctx = getExtractionScope();
    var scope = ctx.scope;
    var scopeLabel = ctx.label;
    log('extractDetail: 搜索范围 = ' + scopeLabel + (ctx.scope.offsetHeight ? ' (高=' + ctx.scope.offsetHeight + ')' : ''));

    // ======== 商家名称 ========
    var name = extractName(scope, ctx);

    if (!name) {
      log('extractDetail: 无有效商家名称，跳过');
      return null;
    }

    // ======== 评分 ========
    var rating = extractRating(scope, ctx);

    // ======== 评论数 ========
    var reviews = extractReviews(scope, ctx);

    // ======== 地址 ========
    var address = extractAddress(scope, ctx);

    // ======== 电话 ========
    var phone = extractPhone(scope, ctx);

    // ======== 网站 ========
    var website = extractWebsite(scope, ctx);

    // ======== 汇总 ========
    var result = {
      name: name,
      rating: rating,
      reviews: reviews,
      address: address,
      phone: phone,
      website: website
    };

    log('extractDetail: 完成 -> ' + JSON.stringify(result));
    return result;
  }

  /**
   * 提取商家名称 - v6 多策略
   *
   * 关键发现：Google Maps 的商家名称可能在：
   * - h1.DUwDvf（传统侧边栏布局）
   * - h1.fontHeadlineLarge（某些布局）
   * - div.qBF1Pd.fontHeadlineSmall（弹窗式/新版布局，class含混淆名）
   * - h1.fontTitleLarge 之后的兄弟元素（搜索标题和详情标题在同级）
   *
   * 策略优先级：
   * 1. 排除 h1.fontTitleLarge（这是"结果"标题，不是商家名）
   * 2. 在详情面板子容器内找 div.fontHeadlineSmall（最常见）
   * 3. h1（排除已知的无效 class）
   * 4. h2
   */
  /**
   * 提取商家名称 - v8 改进
   *
   * 关键改进：通过 isInSearchList() 在所有策略中排除搜索列表区域内的元素
   */
  function extractName(scope, ctx) {
    var feed = ctx && ctx.feedElement;

    // 策略1: div.fontHeadlineSmall（详情面板内的商家名称）
    var headlineDivs = scope.querySelectorAll('div[class*="fontHeadlineSmall"], div.qBF1Pd');
    for (var di = 0; di < headlineDivs.length; di++) {
      var div = headlineDivs[di];
      var divText = div.textContent.trim();
      // 跳过不可见的
      if (div.offsetHeight === 0) continue;
      // v8: 跳过搜索列表区域内的（关键！）
      if (isInSearchList(div)) continue;
      if (isValidName(divText)) {
        log('extractName: div.fontHeadlineSmall -> "' + divText.substring(0, 60) + '"');
        return divText;
      }
    }

    // 策略2: h1 但排除 h1.fontTitleLarge（"结果"标题）
    var allH1 = scope.querySelectorAll('h1');
    for (var i = 0; i < allH1.length; i++) {
      var h = allH1[i];
      var text = h.textContent.trim();
      if (h.offsetHeight === 0) continue;
      // 排除 "结果" 标题
      if (h.className && (h.className.indexOf('fontTitlelarge') !== -1 || h.className.indexOf('fontTitleLarge') !== -1)) continue;
      // v8: 排除搜索列表区域内的
      if (isInSearchList(h)) continue;
      if (isValidName(text)) {
        log('extractName: h1 class="' + h.className.substring(0, 40) + '" -> "' + text.substring(0, 50) + '"');
        return text;
      }
    }

    // 策略3: h1.DUwDvf / h1.fontHeadlineLarge（传统布局）
    var h1Specific = scope.querySelector('h1.DUwDvf') || scope.querySelector('h1.fontHeadlineLarge');
    if (h1Specific && !isInSearchList(h1Specific) && isValidName(h1Specific.textContent.trim())) {
      log('extractName: h1 specific -> "' + h1Specific.textContent.trim().substring(0, 50) + '"');
      return h1Specific.textContent.trim();
    }

    // 策略4: h2
    var allH2 = scope.querySelectorAll('h2');
    for (var j = 0; j < allH2.length; j++) {
      if (allH2[j].offsetHeight === 0) continue;
      if (isInSearchList(allH2[j])) continue;
      var h2text = allH2[j].textContent.trim();
      if (isValidName(h2text)) {
        log('extractName: h2 -> "' + h2text.substring(0, 50) + '"');
        return h2text;
      }
    }

    // 策略5: 任何 fontHeadline div
    var anyHeadline = scope.querySelectorAll('div[class*="fontHeadline"]');
    for (var k = 0; k < anyHeadline.length; k++) {
      if (anyHeadline[k].offsetHeight === 0) continue;
      if (isInSearchList(anyHeadline[k])) continue;
      var dText = anyHeadline[k].textContent.trim();
      if (isValidName(dText)) {
        log('extractName: div fontHeadline -> "' + dText.substring(0, 50) + '"');
        return dText;
      }
    }

    log('extractName: 所有策略均未找到有效名称');
    return '';
  }

  /**
   * 验证名称是否有效
   */
  function isValidName(text) {
    if (!text || text.length === 0) return false;
    if (text.length > 200) return false; // 太长的不太可能是名称

    // 已知的无效名称列表
    var invalidNames = [
      'Google Maps', 'Google 地图', 'Maps', '地图',
      '结果', 'Results', 'Search Results', '搜索结果',
      'Explore', '探索', 'Directions', '路线',
      'Contribute', '贡献', 'Saved', '已保存',
      'Google', 'Sign in', '登录'
    ];

    var lower = text.toLowerCase();
    for (var i = 0; i < invalidNames.length; i++) {
      if (lower === invalidNames[i].toLowerCase()) return false;
    }

    // 包含 "Google" 且很短的排除
    if (text.indexOf('Google') !== -1 && text.length < 20) return false;

    // 纯数字排除
    if (/^\d+$/.test(text)) return false;

    return true;
  }

  /**
   * 提取评分 - v8 改进
   * 关键改进：所有策略都用 isInSearchList() 排除搜索列表区域内的评分
   */
  function extractRating(scope, ctx) {
    var rating = '';
    var candidates = [];

    // 策略1: aria-label 包含 "X.X stars" 格式（小数点评分更可信）
    var starsEls = scope.querySelectorAll('[aria-label*="stars" i], [aria-label*="星" i]');
    for (var i = 0; i < starsEls.length; i++) {
      var sel = starsEls[i];
      // v8: 排除搜索列表区域内的评分
      if (isInSearchList(sel)) continue;
      var aria = sel.getAttribute('aria-label') || '';
      var match = aria.match(/(\d+\.?\d*)\s*stars?/i);
      if (match) {
        var val = match[1];
        candidates.push({ value: val, source: 'aria-label stars', hasDecimal: val.indexOf('.') !== -1 });
      }
    }

    // 策略2: span[role="img"] (Google 用 role="img" 显示评分星级图标)
    var imgEls = scope.querySelectorAll('span[role="img"][aria-label]');
    for (var j = 0; j < imgEls.length; j++) {
      var imgEl = imgEls[j];
      // v8: 排除搜索列表区域内的
      if (isInSearchList(imgEl)) continue;
      var aria2 = imgEl.getAttribute('aria-label') || '';
      var match3 = aria2.match(/(\d+\.?\d*)/);
      if (match3 && parseFloat(match3[1]) <= 5) {
        var alreadyHave = false;
        for (var ci = 0; ci < candidates.length; ci++) {
          if (candidates[ci].value === match3[1]) { alreadyHave = true; break; }
        }
        if (!alreadyHave) {
          candidates.push({ value: match3[1], source: 'span[role=img]', hasDecimal: match3[1].indexOf('.') !== -1, likelyIcon: true });
        }
      }
    }

    // 策略3: 从包含评分的按钮文字中提取（如 "4.2 ☆"）
    var ratingBtns = scope.querySelectorAll('button[aria-label*="stars" i]');
    for (var bi = 0; bi < ratingBtns.length; bi++) {
      var btn = ratingBtns[bi];
      // v8: 排除搜索列表区域内的
      if (isInSearchList(btn)) continue;
      var btnText = btn.textContent.trim();
      var btnMatch = btnText.match(/(\d+\.\d+)/);
      if (btnMatch) {
        var alreadyHave2 = false;
        for (var ci2 = 0; ci2 < candidates.length; ci2++) {
          if (candidates[ci2].value === btnMatch[1]) { alreadyHave2 = true; break; }
        }
        if (!alreadyHave2) {
          candidates.push({ value: btnMatch[1], source: 'button text', hasDecimal: true });
        }
      }
    }

    // 选择最佳候选：优先小数评分（如4.2），然后非图标来源的整数
    if (candidates.length > 0) {
      // 优先有小数点的（更可能是实际评分）
      var decimalCandidates = candidates.filter(function(c) { return c.hasDecimal; });
      if (decimalCandidates.length > 0) {
        rating = decimalCandidates[0].value;
        log('extractRating: ' + rating + ' (source: ' + decimalCandidates[0].source + ', candidates=' + candidates.length + ')');
        return rating;
      }
      // 降级：取第一个非图标候选
      var nonIconCandidates = candidates.filter(function(c) { return !c.likelyIcon; });
      if (nonIconCandidates.length > 0) {
        rating = nonIconCandidates[0].value;
        log('extractRating: ' + rating + ' (source: ' + nonIconCandidates[0].source + ', candidates=' + candidates.length + ')');
        return rating;
      }
      // 最后降级
      rating = candidates[0].value;
      log('extractRating: ' + rating + ' (source: ' + candidates[0].source + ', fallback, candidates=' + candidates.length + ')');
      return rating;
    }

    // 策略4: 通用 fallback 选择器
    var fallbackSels = [
      'span.BFQ3Mc',
      'div.F7nice > span:first-child',
      'span.MW4etd',
      'div.eK4R0e',
      'span.Aq14fc'
    ];
    var fbEl = queryFirst(scope, fallbackSels);
    if (fbEl && !isInSearchList(fbEl)) {
      var fbText = fbEl.textContent.trim();
      var fbMatch = fbText.match(/(\d+\.?\d*)/);
      if (fbMatch && parseFloat(fbMatch[1]) <= 5) {
        rating = fbMatch[1];
        log('extractRating: fallback -> ' + rating);
      }
    }

    log('extractRating: final = "' + rating + '" (candidates=' + candidates.length + ')');
    return rating;
  }

  /**
   * 提取评论数
   */
  function extractReviews(scope, ctx) {
    var reviews = '0';

    // 策略1: aria-label 包含 "reviews"
    var reviewEls = scope.querySelectorAll('[aria-label*="reviews" i], [aria-label*="条评价" i], [aria-label*="评论" i], [aria-label*="Google reviews" i]');
    for (var i = 0; i < reviewEls.length; i++) {
      var rel = reviewEls[i];
      // v8: 排除搜索列表区域内的
      if (isInSearchList(rel)) continue;
      var aria = rel.getAttribute('aria-label') || '';
      var match = aria.match(/([\d,]+)\s*reviews?/i);
      if (match) {
        reviews = match[1].replace(/,/g, '');
        log('extractReviews: aria-label -> ' + reviews);
        return reviews;
      }
    }

    // 策略2: 按钮内含 "review" 文字
    var btnSels = [
      'button[aria-label*="review" i] span',
      'a[href*="reviews"] span',
      'span[aria-label*="Review" i]'
    ];
    var btnEl = queryFirst(scope, btnSels);
    if (btnEl && !isInSearchList(btnEl)) {
      var btnText = btnEl.textContent.trim();
      var btnMatch = btnText.match(/([\d,]+)/);
      if (btnMatch) {
        reviews = btnMatch[1].replace(/,/g, '');
        log('extractReviews: button span -> ' + reviews);
        return reviews;
      }
    }

    // 策略3: 通用 fallback
    var fbSels = ['span.FhRost', 'div.jANrlb'];
    var fbEl = queryFirst(scope, fbSels);
    if (fbEl && !isInSearchList(fbEl)) {
      var fbText = fbEl.textContent.trim();
      var fbMatch = fbText.match(/([\d,]+)/);
      if (fbMatch) {
        reviews = fbMatch[1].replace(/,/g, '');
        log('extractReviews: fallback -> ' + reviews);
      }
    }

    log('extractReviews: final = "' + reviews + '"');
    return reviews;
  }

  /**
   * 提取地址
   */
  function extractAddress(scope, ctx) {
    var address = '';

    // 策略1: aria-label 包含 "Address:"
    var addrEls = scope.querySelectorAll('[aria-label*="Address" i], [aria-label*="地址" i]');
    for (var i = 0; i < addrEls.length; i++) {
      var el = addrEls[i];
      // v8: 排除搜索列表区域内的元素
      if (isInSearchList(el)) continue;
      var aria = el.getAttribute('aria-label') || '';
      var dataId = el.getAttribute('data-item-id') || '';

      // 优先匹配 "Address: xxx" 格式
      var match = aria.match(/^Address:\s*(.+)/i) || aria.match(/^地址[\uFF1A:]\s*(.+)/);
      if (match && match[1].trim()) {
        address = match[1].trim();
        log('extractAddress: aria-label -> "' + address.substring(0, 60) + '"');
        return address;
      }

      // 如果 aria-label 只是 "Address" 没有值，取 textContent
      if ((aria.toLowerCase() === 'address' || aria.toLowerCase() === '地址') && addrEls[i].textContent.trim()) {
        address = getBtnText(addrEls[i]).trim();
        if (address && address.length > 5) {
          log('extractAddress: aria-label+textContent -> "' + address.substring(0, 60) + '"');
          return address;
        }
      }

      // aria-label 中包含 "Address" 但格式不标准
      if (aria.indexOf('Address') !== -1 || aria.indexOf('地址') !== -1) {
        var cleaned = aria.replace(/^.*Address[:\s]*/i, '').replace(/^.*地址[\uFF1A:\s]*/, '').trim();
        if (cleaned && cleaned.length > 5 && cleaned.length < 200) {
          address = cleaned;
          log('extractAddress: aria-label cleaned -> "' + address.substring(0, 60) + '"');
          return address;
        }
      }
    }

    // 策略2: data-item-id="address" 按钮
    var addrBtns = scope.querySelectorAll('button[data-item-id^="address"], button[data-item-id="address"]');
    for (var j = 0; j < addrBtns.length; j++) {
      if (isInSearchList(addrBtns[j])) continue;
      var text = getBtnText(addrBtns[j]).trim();
      if (text && text.length > 5 && text !== 'Address' && text !== '地址') {
        address = text;
        log('extractAddress: data-item-id button -> "' + address.substring(0, 60) + '"');
        return address;
      }
    }

    // 策略3: 通过 aria-label 为 "Copy address" 的按钮获取父级或相邻元素
    var copyBtn = scope.querySelector('[aria-label*="Copy address" i], [aria-label*="复制地址" i]');
    if (copyBtn && !isInSearchList(copyBtn)) {
      // 通常地址文字在复制按钮的上方或同级
      var parent = copyBtn.parentElement;
      if (parent) {
        var prev = parent.previousElementSibling;
        if (prev && prev.textContent.trim().length > 5) {
          address = prev.textContent.trim();
          log('extractAddress: near copy button -> "' + address.substring(0, 60) + '"');
          return address;
        }
      }
    }

    log('extractAddress: final = "' + address.substring(0, 60) + '"');
    return address;
  }

  /**
   * 提取电话
   */
  function extractPhone(scope, ctx) {
    var phone = '';

    // 策略1: aria-label 包含 "Phone:"
    var phoneEls = scope.querySelectorAll('[aria-label*="Phone" i], [aria-label*="电话" i]');
    for (var i = 0; i < phoneEls.length; i++) {
      var pel = phoneEls[i];
      // v8: 排除搜索列表区域内的元素
      if (isInSearchList(pel)) continue;
      var aria = pel.getAttribute('aria-label') || '';

      // "Phone: +1 xxx" 格式
      var match = aria.match(/^Phone:\s*(.+)/i) || aria.match(/^电话[\uFF1A:]\s*(.+)/);
      if (match && match[1].trim()) {
        phone = match[1].trim();
        log('extractPhone: aria-label -> "' + phone + '"');
        return phone;
      }

      // aria-label 只是 "Phone"，取 textContent
      if ((aria.toLowerCase() === 'phone' || aria.toLowerCase() === '电话') && pel.textContent.trim()) {
        phone = getBtnText(pel).trim();
        if (phone && phone.length > 5) {
          log('extractPhone: aria-label+textContent -> "' + phone + '"');
          return phone;
        }
      }

      // 不标准格式
      if (aria.indexOf('Phone') !== -1 || aria.indexOf('电话') !== -1) {
        var cleaned = aria.replace(/^.*Phone[:\s]*/i, '').replace(/^.*电话[\uFF1A:\s]*/, '').trim();
        if (cleaned && cleaned.length > 5) {
          phone = cleaned;
          log('extractPhone: cleaned -> "' + phone + '"');
          return phone;
        }
      }
    }

    // 策略2: data-item-id="phone" 按钮
    var phoneBtns = scope.querySelectorAll('button[data-item-id^="phone"], a[data-item-id^="phone"]');
    for (var j = 0; j < phoneBtns.length; j++) {
      if (isInSearchList(phoneBtns[j])) continue;
      var text = getBtnText(phoneBtns[j]).trim();
      if (text && text.length > 5 && text !== 'Phone' && text !== '电话') {
        phone = text;
        log('extractPhone: data-item-id -> "' + phone + '"');
        return phone;
      }
    }

    // 策略3: href="tel:" 链接
    var telLinks = scope.querySelectorAll('a[href^="tel:"]');
    for (var ti = 0; ti < telLinks.length; ti++) {
      if (isInSearchList(telLinks[ti])) continue;
      phone = telLinks[ti].getAttribute('href').replace('tel:', '');
      log('extractPhone: tel: link -> "' + phone + '"');
      return phone;
    }

    log('extractPhone: final = "' + phone + '"');
    return phone;
  }

  /**
   * 提取网站
   */
  function extractWebsite(scope, ctx) {
    var website = '';

    // 策略1: aria-label 包含 "Website:"
    var webEls = scope.querySelectorAll('[aria-label*="Website" i], [aria-label*="网站" i], [aria-label*="web" i]');
    for (var i = 0; i < webEls.length; i++) {
      var el = webEls[i];
      if (isInSearchList(el)) continue;
      var aria = el.getAttribute('aria-label') || '';

      // "Website: example.com" 格式
      var match = aria.match(/^Website:\s*(.+)/i) || aria.match(/^网站[\uFF1A:]\s*(.+)/);
      if (match && match[1].trim()) {
        var url = match[1].trim();
        if (url.indexOf('http') !== 0 && url.indexOf('www.') !== 0 && url.indexOf('.') > 0) {
          url = 'https://' + url;
        }
        if (url.indexOf('http') === 0) {
          website = url;
          log('extractWebsite: aria-label -> "' + website + '"');
          return website;
        }
      }
    }

    // 策略2: data-item-id="authority" 链接（Google 内部命名）
    var authLinks = scope.querySelectorAll('a[data-item-id="authority"], a[data-item-id^="authority"]');
    for (var ai = 0; ai < authLinks.length; ai++) {
      if (isInSearchList(authLinks[ai])) continue;
      var href = authLinks[ai].href || '';
      if (href && href.indexOf('google.com/maps') === -1) {
        website = href;
        log('extractWebsite: authority link -> "' + website + '"');
        return website;
      }
    }

    // 策略3: 指向外部网站的链接（排除 google.com 和已知扩展域名）
    // 排除已知非商家网站域名
    var excludedDomains = [
      'google.com', 'gstatic.com', 'maps.googleapis.com',
      'keywordseverywhere.com', 'moz.com', 'semrush.com',
      'ahrefs.com', 'similarweb.com', 'extensions', 'chrome-extension'
    ];
    var allLinks = scope.querySelectorAll('a[href]');
    for (var j = 0; j < allLinks.length; j++) {
      var link = allLinks[j];
      var linkHref = link.href || '';
      if (!linkHref) continue;
      if (linkHref.indexOf('javascript:') === 0) continue;

      // 排除已知域名
      var isExcluded = false;
      for (var ex = 0; ex < excludedDomains.length; ex++) {
        if (linkHref.indexOf(excludedDomains[ex]) !== -1) {
          isExcluded = true;
          break;
        }
      }
      if (isExcluded) continue;

      // 有效的 URL 且不在搜索结果卡片内
      if ((linkHref.indexOf('http://') === 0 || linkHref.indexOf('https://') === 0) && linkHref.indexOf('.') > 6) {
        // v8: 排除搜索列表区域内的链接
        if (isInSearchList(link)) continue;
        website = linkHref;
        log('extractWebsite: external link -> "' + website + '"');
        return website;
      }
    }

    // 策略4: data-tooltip 包含 website
    var tipEls = scope.querySelectorAll('[data-tooltip*="website" i], [data-tooltip*="网站" i]');
    for (var k = 0; k < tipEls.length; k++) {
      if (tipEls[k].href && tipEls[k].href.indexOf('google.com') === -1) {
        website = tipEls[k].href;
        log('extractWebsite: data-tooltip link -> "' + website + '"');
        return website;
      }
    }

    log('extractWebsite: final = "' + (website ? website : '(none)') + '"');
    return website;
  }

  // =====================================================
  // 等待与导航
  // =====================================================

  function waitForResultsPanel(timeout) {
    if (!timeout) timeout = 15000;
    return new Promise(function(resolve) {
      log('等待搜索结果面板加载...');
      function check() {
        var panel = document.querySelector('div[role="feed"]') || document.querySelector('div.m6QErb');
        if (panel) { log('搜索结果面板已找到'); resolve(true); return true; }
        return false;
      }
      if (check()) return;
      var elapsed = 0;
      var timer = setInterval(function() {
        elapsed += 500;
        if (check()) { clearInterval(timer); return; }
        if (elapsed >= timeout) { clearInterval(timer); log('等待搜索结果面板超时'); resolve(false); }
      }, 500);
    });
  }

  function waitForAtLeastOneCard(timeout) {
    if (!timeout) timeout = 10000;
    return new Promise(function(resolve) {
      function check() {
        var count = document.querySelectorAll('div.Nv2PK').length;
        var fbCount = document.querySelectorAll('div[jsaction*="mouseover"]').length;
        if (count > 0 || fbCount > 0) { log('找到 ' + count + ' 个卡片'); resolve(count > 0 ? count : fbCount); return true; }
        return false;
      }
      if (check()) return;
      var elapsed = 0;
      var timer = setInterval(function() {
        elapsed += 500;
        if (check()) { clearInterval(timer); return; }
        if (elapsed >= timeout) { clearInterval(timer); log('等待卡片超时'); resolve(0); }
      }, 500);
    });
  }

  /**
   * 等待详情面板加载完成
   * v8: 使用 getExtractionScope() 获取精确范围，等待名称匹配
   */
  function waitForDetail(timeout, expectedName) {
    if (!timeout) timeout = 15000;
    return new Promise(function(resolve) {
      var resolved = false;

      function checkReady() {
        var ctx = getExtractionScope();
        var scope = ctx.scope;
        // v8: 使用精确的 scope 提取名称
        var name = extractName(scope, ctx);
        // 检查是否有加载指示器（详情面板的特征元素）— 只在精确 scope 内搜索
        var hasIndicator = !!(
          scope.querySelector('[aria-label*="Suggest an edit" i]') ||
          scope.querySelector('[aria-label*="Save" i]') ||
          scope.querySelector('[aria-label*="Share" i]') ||
          scope.querySelector('[aria-label*="Directions" i]') ||
          scope.querySelector('[aria-label*="reviewlegaldisclosure" i]') ||
          scope.querySelector('button[aria-label*="Close" i]')
        );
        return { name: name, hasIndicator: hasIndicator };
      }

      // 立即检查
      var immediate = checkReady();
      if (immediate.name && immediate.hasIndicator) {
        // 如果有预期名称，检查是否匹配
        if (!expectedName || !immediate.name || namesMatch(immediate.name, expectedName)) {
          log('waitForDetail: 即时就绪, name="' + immediate.name + '"');
          resolved = true;
          resolve(true);
          return;
        }
      }

      var elapsed = 0;
      var stableCount = 0;
      var lastName = '';
      var hadIndicator = false;

      var timer = setInterval(function() {
        elapsed += 500;
        if (resolved) { clearInterval(timer); return; }

        var current = checkReady();
        if (current.hasIndicator) hadIndicator = true;

        if (current.name) {
          // v7: 如果有预期名称，检查名称是否已更新为预期商家
          if (expectedName && current.name !== expectedName && !namesMatch(current.name, expectedName)) {
            // 名称还没更新到目标商家，继续等待（但有超时保护）
            stableCount = 0;
            lastName = current.name;
            if (elapsed < timeout * 0.7) {
              log('waitForDetail: 名称="' + current.name + '" 不匹配预期="' + expectedName + '"，继续等待...');
              return;
            }
            // 超过70%超时时间还不匹配，可能是名称略有不同，用降级逻辑
          }

          if (current.name === lastName) {
            stableCount++;
          } else {
            stableCount = 0;
            lastName = current.name;
          }

          if (stableCount >= 2 && (hadIndicator || current.hasIndicator)) {
            resolved = true;
            clearInterval(timer);
            log('waitForDetail: 就绪 (' + elapsed + 'ms), name="' + current.name + '"');
            resolve(true);
            return;
          }
          if (stableCount >= 4) {
            resolved = true;
            clearInterval(timer);
            log('waitForDetail: 降级就绪 (' + elapsed + 'ms), name="' + current.name + '"');
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
          if (current.name) {
            log('waitForDetail: 超时但有名称 (' + timeout + 'ms), name="' + current.name + '"');
            resolve(true);
          } else {
            log('waitForDetail: 超时 (' + timeout + 'ms)');
            resolve(false);
          }
        }
      }, 500);
    });
  }

  /**
   * 比较两个名称是否匹配（容错：忽略大小写、多余空格、特殊字符）
   */
  function namesMatch(name1, name2) {
    if (!name1 || !name2) return false;
    // 标准化：转小写、去首尾空格、去多余空格
    var n1 = name1.toLowerCase().trim().replace(/\s+/g, ' ');
    var n2 = name2.toLowerCase().trim().replace(/\s+/g, ' ');
    if (n1 === n2) return true;
    // 一个包含另一个（处理截断情况）
    if (n1.length > 5 && n2.length > 5) {
      if (n1.indexOf(n2) !== -1 || n2.indexOf(n1) !== -1) return true;
    }
    return false;
  }

  async function goBackToListAndWait(timeout) {
    if (!timeout) timeout = 8000;
    var backBtn = document.querySelector(
      'button[aria-label*="Back" i], button[aria-label*="back" i], ' +
      'button[aria-label*="Close" i], button[aria-label*="close" i], ' +
      'button[aria-label*="关闭" i]'
    );
    if (!backBtn) {
      log('goBackToList: 未找到返回按钮，尝试用 Escape');
      // 尝试按 Escape 返回
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      await randomDelay(500, 1000);
    } else {
      backBtn.click();
      log('goBackToList: 已点击返回');
    }
    // 等待搜索结果面板恢复
    await randomDelay(1000, 2000);
    var result = await waitForResultsPanel(timeout);
    if (result) {
      // 额外等待卡片稳定
      await randomDelay(500, 1000);
    }
    return result;
  }

  async function loadMoreResults(target) {
    var cardSel = 'div.Nv2PK';
    var prevCount = 0;
    var noChange = 0;

    for (var attempt = 0; attempt < 30; attempt++) {
      var currentCount = document.querySelectorAll(cardSel).length;
      if (currentCount >= target) {
        log('已加载足够结果: ' + currentCount + ' >= ' + target);
        break;
      }

      var panel = document.querySelector('div[role="feed"]');
      if (panel) {
        panel.scrollIntoView({ behavior: 'smooth', block: 'end' });
        await randomDelay(300, 600);
        window.scrollBy({ top: 800, behavior: 'smooth' });
      } else {
        window.scrollBy({ top: 1000, behavior: 'instant' });
      }

      await randomDelay(2000, 3500);

      var newCount = document.querySelectorAll(cardSel).length;
      log('滚动 ' + attempt + ': ' + currentCount + ' -> ' + newCount + ' (target: ' + target + ')');

      if (newCount === prevCount) {
        noChange++;
        var endEl = document.querySelector('div[aria-label*="End of results"], div[aria-label*="end"]');
        if ((endEl && noChange >= 2) || noChange >= 6) {
          log('到底了: ' + newCount + ' 条');
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

      if (hasCaptcha()) { send('captcha', {}); return false; }
    }

    log('滚动完成，共 ' + document.querySelectorAll(cardSel).length + ' 条');
    return true;
  }

  // =====================================================
  // 主采集流程
  // =====================================================
  async function startScraper(targetCount) {
    if (isRunning) { log('采集已在运行中'); return; }
    isRunning = true;
    abortFlag = false;
    maxResults = targetCount;

    var success = 0;
    var failed = 0;

    log('启动采集 v8，目标: ' + targetCount + ' 条');
    send('progress', {
      status: 'running', current: 0, total: 0, success: 0, failed: 0,
      message: '等待搜索结果加载...',
    });

    // 1. 等待搜索结果面板
    var panelReady = await waitForResultsPanel(15000);
    if (!panelReady || abortFlag) {
      send('progress', { status: 'completed', current: 0, total: 0, success: 0, failed: 0, message: '未找到搜索结果面板' });
      isRunning = false;
      return;
    }

    // 2. 等待至少一个卡片
    var initialCards = await waitForAtLeastOneCard(10000);
    if (initialCards === 0 || abortFlag) {
      send('progress', { status: 'completed', current: 0, total: 0, success: 0, failed: 0, message: '搜索结果为空' });
      isRunning = false;
      return;
    }

    // 3. 滚动加载
    send('progress', { status: 'running', current: 0, total: 0, success: 0, failed: 0, message: '开始滚动加载...' });
    var ok = await loadMoreResults(targetCount);
    if (!ok) { isRunning = false; return; }

    var cards = document.querySelectorAll('div.Nv2PK');
    var limit = Math.min(cards.length, targetCount);
    log('共 ' + cards.length + ' 个卡片，将采集 ' + limit + ' 条');
    send('progress', { status: 'running', current: 0, total: limit, success: 0, failed: 0, message: '找到 ' + cards.length + ' 条，开始采集...' });

    if (limit === 0) {
      send('progress', { status: 'completed', current: 0, total: 0, success: 0, failed: 0, message: '未找到搜索结果卡片' });
      isRunning = false;
      return;
    }

    // 4. 逐条点击采集
    var prevDetailName = '';
    for (var i = 0; i < limit; i++) {
      if (abortFlag) {
        send('progress', { status: 'paused', current: i, total: limit, success: success, failed: failed, message: '采集已暂停' });
        isRunning = false;
        return;
      }

      try {
        send('progress', { status: 'running', current: i + 1, total: limit, success: success, failed: failed, message: '正在采集第 ' + (i + 1) + '/' + limit + ' 条...' });

        var freshCards = document.querySelectorAll('div.Nv2PK');
        if (i >= freshCards.length) { failed++; continue; }

        var cardNameEl = freshCards[i].querySelector('.fontHeadlineSmall, .qBF1Pd, [class*="fontHeadline"]');
        var cardName = cardNameEl ? cardNameEl.textContent.trim() : '';

        freshCards[i].scrollIntoView({ behavior: 'smooth', block: 'center' });
        await randomDelay(800, 1500);

        if (hasCaptcha()) { send('captcha', {}); isRunning = false; return; }

        log('点击第 ' + (i + 1) + ' 个卡片: "' + cardName.substring(0, 30) + '"');
        freshCards[i].click();
        await randomDelay(2000, 3500);

        // v8: 传入预期名称，等待详情面板更新到该商家
        var detailReady = await waitForDetail(15000, cardName);
        if (hasCaptcha()) { send('captcha', {}); isRunning = false; return; }

        if (!detailReady) {
          log('第 ' + (i + 1) + ' 条: 详情加载超时');
          failed++;
          await goBackToListAndWait();
          await randomDelay(2000, 3000);
          continue;
        }

        await randomDelay(1500, 2500);

        var data = extractDetail();

        if (data && data.name) {
          // v8: 验证详情名称与卡片名称是否匹配
          if (cardName && !namesMatch(data.name, cardName)) {
            log('第 ' + (i + 1) + ' 条: 详情名称"' + data.name + '"与卡片名称"' + cardName + '"不匹配，等待更新...');
            // 等待更长时间让详情面板更新
            await randomDelay(2000, 3000);
            var retryData = extractDetail();
            if (retryData && retryData.name && (namesMatch(retryData.name, cardName) || retryData.name !== data.name)) {
              data = retryData;
              log('第 ' + (i + 1) + ' 条: 重试后名称="' + data.name + '"');
            } else {
              // 详情确实没有更新，可能是这个商家没有详情页面
              // 但如果名称有效且不是上一个商家的，也接受
              if (prevDetailName && data.name === prevDetailName) {
                failed++;
                log('第 ' + (i + 1) + ' 条: 详情仍为上一个商家，跳过');
                await goBackToListAndWait();
                await randomDelay(1000, 2000);
                prevDetailName = '';
                continue;
              }
            }
          }

          // 二次验证：如果数据与上一个完全一样（名称相同），也标记失败
          if (prevDetailName && data.name === prevDetailName && i > 0) {
            log('第 ' + (i + 1) + ' 条: 名称与上一条重复("' + data.name + '")，跳过');
            failed++;
            await goBackToListAndWait();
            await randomDelay(1000, 2000);
            continue;
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

        send('progress', { status: 'running', current: i + 1, total: limit, success: success, failed: failed, message: '已采集 ' + success + ' 条，失败 ' + failed + ' 条' });

        await goBackToListAndWait();
        await randomDelay(1000, 2000);

      } catch (err) {
        failed++;
        log('❌ 第 ' + (i + 1) + ' 条异常: ' + err.message);
        try { await goBackToListAndWait(); } catch (e) { /* ignore */ }
        await randomDelay(2000, 4000);
      }
    }

    send('progress', { status: 'completed', current: limit, total: limit, success: success, failed: failed, message: '采集完成！成功 ' + success + ' 条，失败 ' + failed + ' 条' });
    log('采集完成: ' + success + ' 成功, ' + failed + ' 失败');
    isRunning = false;
  }

  function stopScraper() {
    abortFlag = true;
    log('收到停止指令');
  }

  // =====================================================
  // 诊断函数（F12 可用）
  // =====================================================
  try {
    var diagCode = [
      'window.diagMaps=function(){',
      '  console.log("========== Google Maps 诊断报告 ==========");',
      '  console.log("URL: "+location.href);',
      '  console.log("lang: "+document.documentElement.lang);',
      '  var main=document.querySelector("div[role=\\"main\\"]");',
      '  var feed=document.querySelector("div[role=\\"feed\\"]");',
      '  var dialog=document.querySelector("div[role=\\"dialog\\"]");',
      '  var modal=document.querySelector("[aria-modal=\\"true\\"]");',
      '  console.log("role=main: "+(main?"YES (h="+main.offsetHeight+")":"NO"));',
      '  console.log("role=feed: "+(feed?"YES":"NO"));',
      '  console.log("role=dialog: "+(dialog?"YES (h="+dialog.offsetHeight+")":"NO"));',
      '  console.log("aria-modal: "+(modal?"YES (h="+modal.offsetHeight+")":"NO"));',
      '',
      '  var scope=dialog||modal||main||document.body;',
      '  console.log("\\n--- h1 元素 ("+scope.querySelectorAll("h1").length+" 个) ---");',
      '  var h1s=scope.querySelectorAll("h1");',
      '  for(var i=0;i<h1s.length;i++){',
      '    console.log("  h1["+i+"]: \\""+h1s[i].textContent.trim().substring(0,80)+"\\" class=\\""+h1s[i].className+"\\"");',
      '  }',
      '',
      '  console.log("\\n--- h2 元素 ("+scope.querySelectorAll("h2").length+" 个) ---");',
      '  var h2s=scope.querySelectorAll("h2");',
      '  for(var j=0;j<h2s.length;j++){',
      '    console.log("  h2["+j+"]: \\""+h2s[j].textContent.trim().substring(0,80)+"\\"");',
      '  }',
      '',
      '  console.log("\\n--- aria-label 元素 (前30个) ---");',
      '  var allAria=scope.querySelectorAll("[aria-label]");',
      '  var c=0;',
      '  for(var k=0;k<allAria.length&&c<30;k++){',
      '    var el=allAria[k];',
      '    var lb=el.getAttribute("aria-label")||"";',
      '    if(!lb)continue;',
      '    c++;',
      '    var info="  <"+el.tagName+"> aria=\\""+lb+"\\"";',
      '    var did=el.getAttribute("data-item-id")||"";',
      '    if(did)info+=" data-item-id=\\""+did+"\\"";',
      '    console.log(info);',
      '  }',
      '',
      '  console.log("\\n--- data-item-id 按钮/链接 ---");',
      '  var itemEls=scope.querySelectorAll("[data-item-id]");',
      '  for(var m=0;m<itemEls.length;m++){',
      '    var ie=itemEls[m];',
      '    if(ie.tagName!=="BUTTON"&&ie.tagName!=="A")continue;',
      '    console.log("  <"+ie.tagName+"> data-item-id=\\""+ie.getAttribute("data-item-id")+"\\" text=\\""+ie.textContent.trim().substring(0,50)+"\\"");',
      '  }',
      '',
      '  console.log("\\n--- 搜索结果卡片 ---");',
      '  console.log("div.Nv2PK: "+document.querySelectorAll("div.Nv2PK").length+" 个");',
      '',
      '  console.log("\\n--- v8: 搜索列表与详情面板分离分析 ---");',
      '  if(main){',
      '    var feedInMain=main.querySelector("div[role=\\"feed\\"]");',
      '    console.log("feed在main内: "+(feedInMain?"YES":"NO"));',
      '    var children=main.children;',
      '    for(var ci=0;ci<children.length;ci++){',
      '      var ch=children[ci];',
      '      var chInfo="  main>child["+ci+"] <"+ch.tagName+"> class=\\""+ch.className.substring(0,60)+"\\"";',
      '      chInfo+=" (w="+ch.offsetWidth+", h="+ch.offsetHeight+")";',
      '      if(ch.contains(feedInMain)) chInfo+=" [包含feed]";',
      '      var starsInCh=ch.querySelectorAll("[aria-label*=\\"stars\\" i]");',
      '      if(starsInCh.length>0) chInfo+=" [stars="+starsInCh.length+"]";',
      '      var nameEls=ch.querySelectorAll("div[class*=\\"fontHeadlineSmall\\"]");',
      '      if(nameEls.length>0) chInfo+=" [names="+nameEls.length+"]";',
      '      console.log(chInfo);',
      '    }',
      '  }',
      '  console.log("\\n========== 诊断结束 ==========");',
      '};',
      'console.log("[Maps Scraper v8] 诊断函数就绪，F12 输入 diagMaps() 使用");'
    ].join('\n');
    var diagScript = document.createElement('script');
    diagScript.textContent = diagCode;
    (document.head || document.documentElement).appendChild(diagScript);
    diagScript.remove();
  } catch (e) {
    log('注入诊断函数失败: ' + e.message);
  }

  // =====================================================
  // 消息监听
  // =====================================================
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg.type) {
      case 'start':
        log('收到采集指令, 目标: ' + (msg.maxResults || 50));
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
        sendResponse({
          panel: !!document.querySelector('div[role="feed"]'),
          cards: document.querySelectorAll('div.Nv2PK').length,
          detailContainer: !!findDetailContainer(),
        });
        break;
    }
    return true;
  });

  chrome.runtime.sendMessage({ type: 'contentReady' }).catch(() => {});
  log('v8 已就绪，等待指令...');
})();
