import { chromium } from 'playwright-core';
import { mkdir } from 'node:fs/promises';
import { collectPage } from './douyin.js';

export function createBrowser(profileDir, options = {}) {
  let contextPromise;
  let currentContext;
  let loginPage;
  let visiblePage;
  const activePages = new Set();
  const isClosedError = error => /Target page, context or browser has been closed|Target closed|Browser has been closed/i.test(String(error?.message || error));
  function clearContext(browser) {
    if (currentContext !== browser) return;
    contextPromise = null;
    currentContext = null;
    loginPage = null;
    visiblePage = null;
    activePages.clear();
  }
  async function context() {
    if (!contextPromise) {
      const launch = (async () => {
        await mkdir(profileDir, { recursive: true });
        const browser = await chromium.launchPersistentContext(profileDir, {
          channel: options.channel || 'msedge', headless: options.headless ?? false,
          chromiumSandbox: true,
          viewport: { width: 1440, height: 900 }, locale: 'zh-CN'
        });
        currentContext = browser;
        browser.once('close', () => clearContext(browser));
        return browser;
      })();
      contextPromise = launch.catch(error => { contextPromise = null; throw error; });
    }
    return contextPromise;
  }
  async function withContext(action) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const browser = await context();
      try { return await action(browser); }
      catch (error) {
        if (attempt || !isClosedError(error)) throw error;
        try { await browser.cookies('https://www.douyin.com'); }
        catch { clearContext(browser); }
      }
    }
  }
  return {
    async openLogin() {
      return withContext(async browser => {
        if (!loginPage || loginPage.isClosed()) loginPage = await browser.newPage();
        await loginPage.goto('https://www.douyin.com/', { waitUntil: 'domcontentloaded', timeout: 45000 });
        await loginPage.bringToFront();
        return { opened: true, url: loginPage.url() };
      });
    },
    async status() {
      return withContext(async browser => {
        const cookies = await browser.cookies('https://www.douyin.com');
        return { sessionSaved: cookies.some(cookie => /^sessionid(?:_ss)?$/.test(cookie.name) && cookie.value) };
      });
    },
    async collect(video, options) {
      return withContext(async browser => {
        let page;
        try {
          return await collectPage(browser, video.url, { ...options, onPage(opened) { page = opened; activePages.add(page); } });
        } finally {
          if (page) {
            activePages.delete(page);
            if (!page.isClosed()) {
              const previous = visiblePage;
              visiblePage = page;
              if (previous && previous !== page && !activePages.has(previous) && !previous.isClosed())
                await previous.close().catch(() => {});
            }
          }
        }
      });
    },
    async close() {
      const browser = contextPromise ? await contextPromise.catch(() => null) : null;
      if (browser) await browser.close().catch(() => {});
      clearContext(browser);
    }
  };
}
