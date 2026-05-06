/**
 * Google Maps 页面选择器配置
 * Google 经常变更 CSS 类名，当选择器失效时只需更新此文件
 */

const SELECTORS = {
  // 搜索结果列表
  searchResults: {
    // 搜索结果面板
    panel: 'div[role="feed"]',
    // 单个结果卡片
    card: 'div.Nv2PK',
    // 备选卡片选择器（当主选择器失效时使用）
    cardFallback: 'div[jsaction*="mouseover"]',
    // 结果区域（用于滚动）
    resultsArea: 'div[role="feed"]',
    // 结束标记 - "已到达末尾"提示
    endOfList: 'div[aria-label*="End of results"], div[aria-label*="end"], button[aria-label*="end"]',
  },

  // 商家详情页
  detail: {
    // 商家名称
    name: 'h1.DUwDvf',
    nameFallback: 'h1.fontHeadlineLarge',

    // 评分 - 主选择器
    rating: 'div.F7nice > span:first-child',
    // 评分 - 备选
    ratingFallback: 'span[role="img"]',

    // 评论数
    reviewCount: 'span[aria-label*="review"]',
    reviewCountFallback: 'button[aria-label*="review"] span',

    // 分类标签
    category: 'button[jsaction*="pane.rating.category"] span:first-child',
    categoryFallback: 'div[aria-label*="Category"]',

    // 地址
    address: 'button[data-item-id="address"]',
    addressFallback: 'button[aria-label*="Address"]',

    // 电话
    phone: 'button[data-item-id^="phone"]',
    phoneFallback: 'button[aria-label*="Phone"]',

    // 网站
    website: 'a[data-item-id="authority"]',
    websiteFallback: 'a[data-tooltip*="website"]',

    // 营业时间
    hours: 'button[data-item-id="oh"]',
    hoursFallback: 'div[aria-label*="Hours"]',

    // 数据项通用选择器（按钮行）
    dataItemButton: 'button[data-item-id]',
    // 数据项值文本
    dataItemValue: '.Io6YTe',
  },

  // 页面元素
  page: {
    // 搜索框
    searchInput: '#searchboxinput',
    // 搜索按钮
    searchButton: '#searchbox-searchbutton',
    // 关闭详情面板按钮（返回列表）
    closeDetail: 'button[aria-label*="Back"]',
    // 验证码/人机验证
    captcha: 'iframe[src*="recaptcha"], div[aria-label*="verify"], form[action*="recaptcha"]',
  },
};

/**
 * 获取地址按钮中的文本
 */
function getAddressText(button) {
  if (!button) return '';
  const valueEl = button.querySelector('.Io6YTe') || button.querySelector('span');
  return valueEl ? valueEl.textContent.trim() : button.textContent.trim();
}

/**
 * 获取电话按钮中的文本
 */
function getPhoneText(button) {
  if (!button) return '';
  const valueEl = button.querySelector('.Io6YTe') || button.querySelector('span');
  let text = valueEl ? valueEl.textContent.trim() : button.textContent.trim();
  // 清理电话号码格式
  return text.replace(/[\s()-]/g, '').replace(/^\+?86/, '') || text;
}

/**
 * 获取评分数字
 */
function getRatingValue(el) {
  if (!el) return '';
  const text = el.textContent.trim();
  const match = text.match(/(\d+\.?\d*)/);
  return match ? match[1] : text;
}

/**
 * 获取评论数
 */
function getReviewCountValue(el) {
  if (!el) return '0';
  const ariaLabel = el.getAttribute('aria-label') || '';
  const match = ariaLabel.match(/(\d[\d,]*)\s*review/i);
  if (match) return match[1].replace(',', '');
  const text = el.textContent.trim();
  const textMatch = text.match(/(\d[\d,]*)/);
  return textMatch ? textMatch[1].replace(',', '') : '0';
}

/**
 * 获取网站链接
 */
function getWebsiteUrl(el) {
  if (!el) return '';
  return el.href || '';
}

module.exports = {
  SELECTORS,
  getAddressText,
  getPhoneText,
  getRatingValue,
  getReviewCountValue,
  getWebsiteUrl,
};
