/**
 * Google Maps 页面选择器配置
 * 当选择器失效时只需更新此文件
 */

const SEL = {
  // 搜索结果列表
  results: {
    panel: 'div[role="feed"]',
    card: 'div.Nv2PK',
    endOfList: 'div[aria-label*="End of results"], div[aria-label*="end"]',
  },

  // 详情页数据
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

  // 页面元素
  page: {
    closeDetail: 'button[aria-label*="Back"]',
    captcha: 'iframe[src*="recaptcha"], div[aria-label*="verify"], form[action*="recaptcha"]',
  },
};

/**
 * 从详情页提取所有数据
 */
function extractDetail() {
  function query(selector, fallback) {
    return document.querySelector(selector) || (fallback ? document.querySelector(fallback) : null);
  }

  function getText(btn) {
    if (!btn) return '';
    const v = btn.querySelector('.Io6YTe') || btn.querySelector('span');
    return v ? v.textContent.trim() : btn.textContent.trim();
  }

  // 商家名称
  const nameEl = query(SEL.detail.name, SEL.detail.nameFallback);
  const name = nameEl ? nameEl.textContent.trim() : '';

  if (!name) return null;

  // 评分
  const ratingEl = query(SEL.detail.rating);
  let rating = '';
  if (ratingEl) {
    const m = ratingEl.textContent.trim().match(/(\d+\.?\d*)/);
    rating = m ? m[1] : '';
  }

  // 评论数
  const reviewEl = query(SEL.detail.reviewCount, SEL.detail.reviewCountFallback);
  let reviews = '0';
  if (reviewEl) {
    const aria = reviewEl.getAttribute('aria-label') || '';
    const m = aria.match(/(\d[\d,]*)\s*review/i);
    reviews = m ? m[1].replace(',', '') : '0';
  }

  // 地址
  const addressBtn = query(SEL.detail.address, SEL.detail.addressFallback);
  const address = getText(addressBtn).replace(/^地址\s*/, '');

  // 电话
  const phoneBtn = query(SEL.detail.phone, SEL.detail.phoneFallback);
  const phone = getText(phoneBtn).replace(/^电话\s*/, '');

  // 网站
  const websiteEl = query(SEL.detail.website, SEL.detail.websiteFallback);
  const website = websiteEl ? websiteEl.href : '';

  return { name, rating, reviews, address, phone, website };
}

/**
 * 检测验证码
 */
function hasCaptcha() {
  return !!document.querySelector(SEL.page.captcha);
}

/**
 * 获取搜索结果卡片数量
 */
function getResultCount() {
  return document.querySelectorAll(SEL.results.card).length;
}

/**
 * 返回搜索结果列表（关闭详情面板）
 */
function goBackToList() {
  const backBtn = document.querySelector(SEL.page.closeDetail);
  if (backBtn) {
    backBtn.click();
    return true;
  }
  return false;
}
