const { chromium } = require('playwright');
const { SELECTORS, getAddressText, getPhoneText, getRatingValue, getReviewCountValue, getWebsiteUrl } = require('./selectors');

// 随机延迟函数（模拟人类操作）
function randomDelay(min = 2000, max = 5000) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise(resolve => setTimeout(resolve, ms));
}

// 检测是否出现验证码
async function checkCaptcha(page) {
  const captchaEl = await page.$(SELECTORS.page.captcha);
  if (captchaEl) {
    return true;
  }
  return false;
}

class ScraperEngine {
  constructor() {
    this.browser = null;
    this.context = null;
    this.page = null;
    this.isRunning = false;
    this.collectedData = [];
    this.progress = {
      status: 'idle', // idle, running, paused, completed, error
      current: 0,
      total: 0,
      success: 0,
      failed: 0,
      message: '',
    };
    this.onProgress = null; // SSE 回调
    this.abortFlag = false;
  }

  setProgressCallback(callback) {
    this.onProgress = callback;
  }

  emitProgress() {
    if (this.onProgress) {
      this.onProgress({ ...this.progress, data: this.collectedData });
    }
  }

  async launchBrowser() {
    this.browser = await chromium.launch({
      headless: false,
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-setuid-sandbox',
      ],
    });

    this.context = await this.browser.newContext({
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });

    this.page = await this.context.newPage();

    // 隐藏 webdriver 标志
    await this.page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
    });
  }

  async closeBrowser() {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.context = null;
      this.page = null;
    }
  }

  async start({ keyword, city, maxResults }) {
    if (this.isRunning) {
      throw new Error('采集任务正在运行中');
    }

    this.isRunning = true;
    this.abortFlag = false;
    this.collectedData = [];
    this.progress = {
      status: 'running',
      current: 0,
      total: maxResults,
      success: 0,
      failed: 0,
      message: '正在启动浏览器...',
    };
    this.emitProgress();

    try {
      await this.launchBrowser();

      // 构造搜索 URL
      const query = `${keyword} ${city}`.trim();
      const searchUrl = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;

      this.progress.message = `正在搜索 "${query}"...`;
      this.emitProgress();

      await this.page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

      // 等待搜索结果加载
      await this.page.waitForSelector(SELECTORS.searchResults.panel, { timeout: 30000 })
        .catch(() => {
          throw new Error('搜索结果加载超时，请检查网络连接或关键词是否正确');
        });

      this.progress.message = '搜索结果已加载，开始滚动加载更多结果...';
      this.emitProgress();

      // 滚动加载更多结果
      await this.loadMoreResults(maxResults);

      this.progress.message = '开始逐条采集商家信息...';
      this.emitProgress();

      // 获取所有搜索结果卡片
      const cards = await this.page.$$(SELECTORS.searchResults.card);

      if (cards.length === 0) {
        this.progress.status = 'completed';
        this.progress.message = '未找到搜索结果';
        this.emitProgress();
        return this.collectedData;
      }

      this.progress.total = Math.min(cards.length, maxResults);
      this.emitProgress();

      // 逐条点击采集
      const limit = Math.min(cards.length, maxResults);
      for (let i = 0; i < limit; i++) {
        if (this.abortFlag) {
          this.progress.status = 'paused';
          this.progress.message = '采集已手动暂停';
          this.emitProgress();
          break;
        }

        try {
          this.progress.current = i + 1;
          this.progress.message = `正在采集第 ${i + 1}/${limit} 条...`;
          this.emitProgress();

          // 重新获取卡片（因为DOM可能已更新）
          const freshCards = await this.page.$$(SELECTORS.searchResults.card);
          if (i >= freshCards.length) {
            this.progress.failed++;
            this.emitProgress();
            continue;
          }

          // 滚动到卡片可见
          await freshCards[i].scrollIntoViewIfNeeded();
          await randomDelay(500, 1500);

          // 点击卡片
          await freshCards[i].click();
          await randomDelay(2000, 3500);

          // 检查验证码
          if (await checkCaptcha(this.page)) {
            this.progress.status = 'paused';
            this.progress.message = '检测到人机验证，请在浏览器中手动完成验证后继续';
            this.emitProgress();
            break;
          }

          // 提取详情数据
          const data = await this.extractDetail();
          if (data) {
            this.collectedData.push(data);
            this.progress.success++;
          } else {
            this.progress.failed++;
          }

          this.emitProgress();

          // 返回搜索结果列表
          await this.goBackToList();

          await randomDelay(1500, 3000);
        } catch (err) {
          console.error(`采集第 ${i + 1} 条失败:`, err.message);
          this.progress.failed++;
          this.emitProgress();

          // 尝试返回列表
          try {
            await this.goBackToList();
          } catch (e) {
            // 如果返回失败，刷新页面
            await this.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
            await this.page.waitForSelector(SELECTORS.searchResults.panel, { timeout: 15000 }).catch(() => {});
          }

          await randomDelay(2000, 4000);
        }
      }

      if (!this.abortFlag) {
        this.progress.status = 'completed';
        this.progress.message = `采集完成！共采集 ${this.progress.success} 条，失败 ${this.progress.failed} 条`;
      }

      this.emitProgress();
    } catch (err) {
      this.progress.status = 'error';
      this.progress.message = `采集出错: ${err.message}`;
      this.emitProgress();
      console.error('采集引擎错误:', err);
    } finally {
      this.isRunning = false;
    }

    return this.collectedData;
  }

  /**
   * 滚动加载更多搜索结果
   */
  async loadMoreResults(targetCount) {
    let previousCount = 0;
    let noChangeCount = 0;
    const maxScrollAttempts = 20;

    for (let attempt = 0; attempt < maxScrollAttempts; attempt++) {
      const cards = await this.page.$$(SELECTORS.searchResults.card);
      if (cards.length >= targetCount) break;

      // 滚动到底部
      await this.page.evaluate(() => {
        const panel = document.querySelector('div[role="feed"]');
        if (panel) {
          panel.scrollIntoView({ block: 'end' });
          // 额外滚动一点确保触发加载
          window.scrollBy(0, 500);
        } else {
          window.scrollBy(0, 800);
        }
      });

      await randomDelay(2000, 4000);

      const newCount = await this.page.$$eval(SELECTORS.searchResults.card, els => els.length);

      if (newCount === previousCount) {
        noChangeCount++;
        if (noChangeCount >= 3) {
          // 检查是否到了末尾
          const endEl = await this.page.$(SELECTORS.searchResults.endOfList);
          if (endEl) break;
          // 再多尝试一次
          if (noChangeCount >= 5) break;
        }
      } else {
        noChangeCount = 0;
        previousCount = newCount;
      }

      // 检查验证码
      if (await checkCaptcha(this.page)) {
        this.progress.status = 'paused';
        this.progress.message = '检测到人机验证，请在浏览器中手动完成验证';
        this.emitProgress();
        break;
      }
    }
  }

  /**
   * 从详情面板提取商家数据
   */
  async extractDetail() {
    try {
      // 等待详情面板出现
      await this.page.waitForSelector(SELECTORS.detail.name, { timeout: 10000 }).catch(() => null);

      // 提取数据（使用 page.evaluate 在浏览器上下文中执行）
      const data = await this.page.evaluate((sel) => {
        const result = {};

        // 商家名称
        const nameEl = document.querySelector(sel.name) || document.querySelector(sel.nameFallback);
        result.name = nameEl ? nameEl.textContent.trim() : '';

        // 评分
        const ratingEl = document.querySelector(sel.rating);
        if (ratingEl) {
          const ratingText = ratingEl.textContent.trim();
          const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
          result.rating = ratingMatch ? ratingMatch[1] : '';
        } else {
          result.rating = '';
        }

        // 评论数 - 从 aria-label 提取
        const reviewEl = document.querySelector(sel.reviewCount) || document.querySelector(sel.reviewCountFallback);
        if (reviewEl) {
          const ariaLabel = reviewEl.getAttribute('aria-label') || '';
          const match = ariaLabel.match(/(\d[\d,]*)\s*review/i);
          result.reviews = match ? match[1].replace(',', '') : '0';
        } else {
          result.reviews = '0';
        }

        // 地址
        const addressBtn = document.querySelector(sel.address) || document.querySelector(sel.addressFallback);
        result.address = addressBtn ?
          (addressBtn.querySelector('.Io6YTe')?.textContent.trim() || addressBtn.textContent.trim().replace(/^地址\s*/, '')) : '';

        // 电话
        const phoneBtn = document.querySelector(sel.phone) || document.querySelector(sel.phoneFallback);
        result.phone = phoneBtn ?
          (phoneBtn.querySelector('.Io6YTe')?.textContent.trim() || phoneBtn.textContent.trim().replace(/^电话\s*/, '')) : '';

        // 网站
        const websiteEl = document.querySelector(sel.website) || document.querySelector(sel.websiteFallback);
        result.website = websiteEl ? websiteEl.href : '';

        return result;
      }, {
        name: SELECTORS.detail.name,
        nameFallback: SELECTORS.detail.nameFallback,
        rating: SELECTORS.detail.rating,
        reviewCount: SELECTORS.detail.reviewCount,
        reviewCountFallback: SELECTORS.detail.reviewCountFallback,
        address: SELECTORS.detail.address,
        addressFallback: SELECTORS.detail.addressFallback,
        phone: SELECTORS.detail.phone,
        phoneFallback: SELECTORS.detail.phoneFallback,
        website: SELECTORS.detail.website,
        websiteFallback: SELECTORS.detail.websiteFallback,
      });

      // 过滤空名称（可能是没有正确加载）
      if (!data.name || data.name.length < 1) {
        return null;
      }

      return data;
    } catch (err) {
      console.error('提取详情失败:', err.message);
      return null;
    }
  }

  /**
   * 返回搜索结果列表
   */
  async goBackToList() {
    try {
      // 方法1: 点击返回按钮
      const backBtn = await this.page.$(SELECTORS.page.closeDetail);
      if (backBtn) {
        await backBtn.click();
        await randomDelay(500, 1000);
        return;
      }

      // 方法2: 使用键盘 Escape
      await this.page.keyboard.press('Escape');
      await randomDelay(500, 1000);
    } catch (err) {
      console.error('返回列表失败:', err.message);
    }
  }

  /**
   * 停止采集
   */
  stop() {
    this.abortFlag = true;
  }

  /**
   * 恢复采集（从暂停状态继续）
   */
  async resume() {
    if (this.progress.status === 'paused' && this.page) {
      this.abortFlag = false;
      this.progress.status = 'running';
      this.progress.message = '继续采集...';
      this.emitProgress();
      // 重新启动采集（从当前位置继续）
      // 简化实现：重新开始
      const remaining = this.progress.total - this.collectedData.length;
      if (remaining > 0) {
        // 重新搜索并跳过已采集的数量
        // TODO: 实现更智能的断点续传
      }
    }
  }
}

module.exports = ScraperEngine;
