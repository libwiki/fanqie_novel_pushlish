import fs from 'node:fs/promises';
import { AUTH_DIR, STATE_FILE, WRITER_HOME_URL } from './constants.js';
import { ensureDir, pathExists, promptEnter } from './io.js';
import { launchHeadlessBrowser, launchVisibleBrowser } from './browser.js';

export async function hasStoredLoginState() {
  return pathExists(STATE_FILE);
}

export async function verifyStoredLoginState() {
  if (!(await hasStoredLoginState())) {
    return { loggedIn: false, reason: '登录凭证不存在' };
  }

  let browser;
  try {
    browser = await launchHeadlessBrowser();
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    await page.goto(WRITER_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(3000);

    const currentUrl = page.url();
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const looksLikeLoginPage =
      /login|passport|sso/i.test(currentUrl) ||
      /扫码登录|验证码登录|手机号登录|登录后继续|请登录/.test(bodyText);

    await context.close();
    return {
      loggedIn: !looksLikeLoginPage,
      reason: looksLikeLoginPage ? '登录凭证已失效或被平台要求重新登录' : '登录态有效'
    };
  } catch (error) {
    return {
      loggedIn: false,
      reason: `无法验证登录态：${error.message}`
    };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function login({ force = false } = {}) {
  await ensureDir(AUTH_DIR);
  let shouldLoadExistingState = false;

  if (!force && (await hasStoredLoginState())) {
    const result = await verifyStoredLoginState();
    if (result.loggedIn) {
      console.log('当前已登录番茄作家平台，无须重复登录。');
      console.log('如需更换账号，请先调用 `fanqie logout` 退出登录。');
      return;
    }
    console.log(`检测到旧登录凭证，但当前不可用：${result.reason}`);
    shouldLoadExistingState = !result.reason.includes('无法验证登录态');
  }

  let browser;
  try {
    browser = await launchVisibleBrowser();
    const contextOptions = shouldLoadExistingState ? { storageState: STATE_FILE } : {};
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();

    console.log('正在打开番茄小说作家后台，请在浏览器窗口中扫码或输入账号登录。');
    await page.goto(WRITER_HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((error) => {
      console.log(`打开网页遇到问题：${error.message}`);
      console.log(`浏览器已保持打开，可手动访问：${WRITER_HOME_URL}`);
    });

    await promptEnter('确认已经进入作家后台首页后，回到终端按回车保存登录状态：');
    await context.storageState({ path: STATE_FILE });
    await context.close();
    console.log(`登录状态已保存：${STATE_FILE}`);
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

export async function logout() {
  if (!(await hasStoredLoginState())) {
    console.log('当前没有保存的番茄登录状态。');
    return;
  }

  await fs.rm(STATE_FILE, { force: true });
  console.log('已退出登录，并删除本地番茄登录凭证。');
}
