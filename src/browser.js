import { chromium } from 'playwright';

export async function launchVisibleBrowser() {
  const preferredChannels = ['msedge', 'chrome'];
  for (const channel of preferredChannels) {
    try {
      return await chromium.launch({ channel, headless: false });
    } catch {
      // 继续尝试下一个本机浏览器，最后回退到 Playwright Chromium。
    }
  }
  return chromium.launch({ headless: false });
}

export async function launchHeadlessBrowser() {
  const preferredChannels = ['msedge', 'chrome'];
  for (const channel of preferredChannels) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch {
      // 继续尝试下一个本机浏览器，最后回退到 Playwright Chromium。
    }
  }
  return chromium.launch({ headless: true });
}
