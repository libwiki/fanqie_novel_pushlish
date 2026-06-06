import path from 'node:path';
import { STATE_FILE, BOOK_MANAGE_URL } from './constants.js';
import { hasStoredLoginState } from './auth.js';
import { launchHeadlessBrowser, launchVisibleBrowser } from './browser.js';
import { cleanSortPrefix, readChapterContent } from './chapter.js';
import { nowIso, promptChoice, promptEnter } from './io.js';
import { loadPublishConfig, writeYamlFile } from './config.js';

class OperationCancelledError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OperationCancelledError';
  }
}

class ChapterSkippedError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ChapterSkippedError';
  }
}

export async function publishChapters({ rootDir, config, count, dryRun = false, force = false }) {
  if (!(await hasStoredLoginState())) {
    throw new Error('当前未登录番茄作家平台，请先调用 `fanqie login` 完成扫码登录。');
  }

  const { publishPath, publishConfig } = await loadPublishConfig(rootDir);
  syncPublishConfigHeader(publishConfig, config);
  syncPublishChapters(publishConfig, config.chapters.items);

  const publishCount = Number(count || config.publish.defaultCount || 3);
  const candidates = limitToFirstVolume(selectPendingChapters(publishConfig, config.chapters.items, { force }), publishCount);
  const warningsByFile = buildChapterWarnings(candidates);

  await writeYamlFile(publishPath, {
    ...publishConfig,
    updatedAt: nowIso()
  });

  if (candidates.length === 0) {
    console.log('没有待发布章节。若修改过稿件，请先执行 `fanqie scan` 更新章节 sha1。');
    return;
  }

  console.log(`本次计划发布 ${candidates.length} 章，发布状态文件：${publishPath}`);
  for (const chapter of candidates) {
    console.log(`- 第${chapter.chapterNumber || chapter.index}章 ${chapter.title} (${chapter.file})`);
  }

  if (dryRun) {
    console.log('dry-run 模式仅输出发布计划，不启动浏览器。');
    return;
  }

  const runId = `run-${Date.now()}`;
  publishConfig.publish.lastRunId = runId;
  publishConfig.publish.startedAt = publishConfig.publish.startedAt || nowIso();
  publishConfig.publish.runs.push({
    id: runId,
    startedAt: nowIso(),
    count: candidates.length,
    status: 'running'
  });
  await writeYamlFile(publishPath, publishConfig);

  let browser;
  let successCount = 0;
  const useHeadlessBrowser = Boolean(config.browser?.headless);
  try {
    if (useHeadlessBrowser) {
      console.log('已启用无头浏览器模式，交互选择将在控制台完成。');
    }
    browser = useHeadlessBrowser ? await launchHeadlessBrowser() : await launchVisibleBrowser();
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    const session = await createPublishSession({
      page,
      context,
      novelName: config.novel.name,
      useConsoleChoice: useHeadlessBrowser
    });

    for (const chapter of candidates) {
      const state = findChapterState(publishConfig, chapter);
      state.status = 'running';
      state.lastRunId = runId;
      state.attempts = Number(state.attempts || 0) + 1;
      state.startedAt = nowIso();
      state.error = '';
      await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });

      try {
        const absFilePath = path.resolve(rootDir, chapter.file);
        const content = await readChapterContent(absFilePath);
        await publishOneChapter({
          session,
          chapter,
          content,
          targetVolume: chapter.volume || config.currentVolume,
          warnings: warningsByFile.get(chapter.file) || [],
          preferredMenuAfterChapter: null
        });

        state.status = 'published';
        state.publishedAt = nowIso();
        state.error = '';
        successCount += 1;
        console.log(`发布成功：第${chapter.chapterNumber || chapter.index}章 ${chapter.title}`);
      } catch (error) {
        if (error instanceof ChapterSkippedError) {
          state.status = 'skipped';
          state.skippedAt = nowIso();
          state.error = error.message;
          console.log(`已跳过：${chapter.file}`);
          await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
          continue;
        }
        if (error instanceof OperationCancelledError) {
          state.status = 'cancelled';
          state.error = error.message;
          console.log(`用户取消，本次发布中断：${error.message}`);
          await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
          break;
        }
        state.status = 'failed';
        state.error = error.message;
        state.failedAt = nowIso();
        console.log(`发布失败：${chapter.file}`);
        console.log(error.message);
        await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
        break;
      }

      await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
    }
    await selectChapterManageMenu(session.chapterManagePage, 'chapters').catch(() => {});
  } finally {
    const run = publishConfig.publish.runs.find((item) => item.id === runId);
    if (run) {
      run.finishedAt = nowIso();
      run.successCount = successCount;
      run.status = successCount === candidates.length ? 'finished' : 'interrupted';
    }
    await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
    if (browser) {
      if (!useHeadlessBrowser) {
        await promptEnter('发布流程结束。检查浏览器无误后，按回车关闭浏览器：').catch(() => {});
      }
      await browser.close().catch(() => {});
    }
  }
}

export async function testPublishFlow({ rootDir, config }) {
  if (!(await hasStoredLoginState())) {
    throw new Error('当前未登录番茄作家平台，请先调用 `fanqie login` 完成扫码登录。');
  }

  const { publishConfig } = await loadPublishConfig(rootDir);
  syncPublishConfigHeader(publishConfig, config);
  syncPublishChapters(publishConfig, config.chapters.items);
  const candidates = selectPendingChapters(publishConfig, config.chapters.items, 1);

  if (candidates.length === 0) {
    console.log('没有可测试的待发布章节。请先执行 `fanqie scan`，或修改稿件后再测试。');
    return;
  }

  const chapter = candidates[0];
  console.log(`本次测试仅模拟 1 章：第${chapter.chapterNumber || chapter.index}章 ${chapter.title} (${chapter.file})`);
  console.log('测试流程会停在最终“确认发布”面板，不会点击“确认发布”。');

  let browser;
  try {
    browser = await launchVisibleBrowser();
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    const session = await createPublishSession({
      page,
      context,
      novelName: config.novel.name
    });
    const absFilePath = path.resolve(rootDir, chapter.file);
    const content = await readChapterContent(absFilePath);

    await publishOneChapter({
      session,
      chapter,
      content,
      targetVolume: chapter.volume || config.currentVolume,
      stopBeforeConfirm: true
    });
  } finally {
    if (browser) {
      await promptEnter('你手动点击取消并检查无误后，按回车关闭浏览器：').catch(() => {});
      await browser.close().catch(() => {});
    }
  }
}

export async function saveDrafts({ rootDir, config, count, dryRun = false }) {
  if (!(await hasStoredLoginState())) {
    throw new Error('当前未登录番茄作家平台，请先调用 `fanqie login` 完成扫码登录。');
  }

  const { publishPath, publishConfig } = await loadPublishConfig(rootDir);
  syncPublishConfigHeader(publishConfig, config);
  syncPublishChapters(publishConfig, config.chapters.items);

  const saveCount = Number(count || config.publish.defaultCount || 3);
  const candidates = limitToFirstVolume(selectDraftCandidates(publishConfig, config.chapters.items), saveCount);
  const warningsByFile = buildChapterWarnings(candidates);

  await writeYamlFile(publishPath, {
    ...publishConfig,
    updatedAt: nowIso()
  });

  if (candidates.length === 0) {
    console.log('没有待保存草稿的章节。若修改过稿件，请先执行 `fanqie scan` 更新章节 sha1。');
    return;
  }

  console.log(`本次计划保存草稿 ${candidates.length} 章，状态文件：${publishPath}`);
  for (const chapter of candidates) {
    console.log(`- 第${chapter.chapterNumber || chapter.index}章 ${chapter.title} (${chapter.file})`);
  }

  if (dryRun) {
    console.log('dry-run 模式仅输出保存计划，不启动浏览器。');
    return;
  }

  const runId = `save-${Date.now()}`;
  publishConfig.publish.lastRunId = runId;
  publishConfig.publish.startedAt = publishConfig.publish.startedAt || nowIso();
  publishConfig.publish.runs.push({
    id: runId,
    type: 'save',
    startedAt: nowIso(),
    count: candidates.length,
    status: 'running'
  });
  await writeYamlFile(publishPath, publishConfig);

  let browser;
  let successCount = 0;
  const useHeadlessBrowser = Boolean(config.browser?.headless);
  try {
    if (useHeadlessBrowser) {
      console.log('已启用无头浏览器模式，交互选择将在控制台完成。');
    }
    browser = useHeadlessBrowser ? await launchHeadlessBrowser() : await launchVisibleBrowser();
    const context = await browser.newContext({ storageState: STATE_FILE });
    const page = await context.newPage();
    const session = await createPublishSession({
      page,
      context,
      novelName: config.novel.name,
      useConsoleChoice: useHeadlessBrowser
    });

    for (const chapter of candidates) {
      const state = findChapterState(publishConfig, chapter);
      state.status = 'saving';
      state.lastRunId = runId;
      state.attempts = Number(state.attempts || 0) + 1;
      state.startedAt = nowIso();
      state.error = '';
      await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });

      try {
        const absFilePath = path.resolve(rootDir, chapter.file);
        const content = await readChapterContent(absFilePath);
        await publishOneChapter({
          session,
          chapter,
          content,
          targetVolume: chapter.volume || config.currentVolume,
          saveDraftOnly: true,
          warnings: warningsByFile.get(chapter.file) || [],
          preferredMenuAfterChapter: null
        });

        state.status = 'drafted';
        state.draftedAt = nowIso();
        state.error = '';
        successCount += 1;
        console.log(`草稿已保存：第${chapter.chapterNumber || chapter.index}章 ${chapter.title}`);
      } catch (error) {
        if (error instanceof ChapterSkippedError) {
          state.status = 'skipped';
          state.skippedAt = nowIso();
          state.error = error.message;
          console.log(`已跳过：${chapter.file}`);
          await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
          continue;
        }
        if (error instanceof OperationCancelledError) {
          state.status = 'cancelled';
          state.error = error.message;
          console.log(`用户取消，本次保存草稿中断：${error.message}`);
          await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
          break;
        }
        state.status = 'failed';
        state.error = error.message;
        state.failedAt = nowIso();
        console.log(`保存草稿失败：${chapter.file}`);
        console.log(error.message);
        await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
        break;
      }

      await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
    }
    await selectChapterManageMenu(session.chapterManagePage, 'drafts').catch(() => {});
  } finally {
    const run = publishConfig.publish.runs.find((item) => item.id === runId);
    if (run) {
      run.finishedAt = nowIso();
      run.successCount = successCount;
      run.status = successCount === candidates.length ? 'finished' : 'interrupted';
    }
    await writeYamlFile(publishPath, { ...publishConfig, updatedAt: nowIso() });
    if (browser) {
      if (!useHeadlessBrowser) {
        await promptEnter('存草稿流程结束。检查浏览器无误后，按回车关闭浏览器：').catch(() => {});
      }
      await browser.close().catch(() => {});
    }
  }
}

function syncPublishConfigHeader(publishConfig, config) {
  publishConfig.novelName = config.novel.name;
  publishConfig.publish.defaultCount = config.publish.defaultCount;
  publishConfig.currentVolume = config.currentVolume;
}

function syncPublishChapters(publishConfig, chapters) {
  publishConfig.chapters.items = Array.isArray(publishConfig.chapters.items) ? publishConfig.chapters.items : [];
  for (const chapter of chapters) {
    const existing = findChapterState(publishConfig, chapter);
    existing.index = chapter.index;
    existing.chapterNumber = chapter.chapterNumber;
    existing.title = chapter.title;
    existing.volume = chapter.volume;
    existing.file = chapter.file;

    if (existing.sha1 && existing.sha1 !== chapter.sha1) {
      existing.status = 'pending';
      existing.previousSha1 = existing.sha1;
      existing.changedAt = nowIso();
      existing.error = '';
    }

    existing.sha1 = chapter.sha1;
    existing.bytes = chapter.bytes;
    existing.status = existing.status || 'pending';
    existing.attempts = Number(existing.attempts || 0);
  }
  publishConfig.chapters.count = publishConfig.chapters.items.length;
}

function selectPendingChapters(publishConfig, chapters, { force = false } = {}) {
  return chapters
    .filter((chapter) => {
      const state = findChapterState(publishConfig, chapter);
      if (force) {
        return true;
      }
      return !(state.status === 'published' && state.sha1 === chapter.sha1);
    });
}

function selectDraftCandidates(publishConfig, chapters) {
  return chapters
    .filter((chapter) => {
      const state = findChapterState(publishConfig, chapter);
      const sameContent = state.sha1 === chapter.sha1;
      return !(sameContent && ['published', 'drafted'].includes(state.status));
    });
}

function limitToFirstVolume(chapters, count) {
  if (chapters.length === 0) {
    return [];
  }
  const firstVolume = normalizeVolumeName(chapters[0].volume);
  const selected = [];
  for (const chapter of chapters) {
    if (selected.length >= count) {
      break;
    }
    if (normalizeVolumeName(chapter.volume) !== firstVolume) {
      break;
    }
    selected.push(chapter);
  }
  return selected;
}

function normalizeVolumeName(value) {
  return cleanSortPrefix(String(value || '').trim());
}

function buildChapterWarnings(chapters) {
  const warningsByFile = new Map();
  const seenNumbers = new Map();
  let previousNumber = null;

  for (const chapter of chapters) {
    const warnings = [];
    const numericNumber = Number.parseInt(chapter.chapterNumber, 10);

    if (!chapter.chapterNumber) {
      warnings.push('章节号缺失');
    }
    if (!chapter.title) {
      warnings.push('章节标题缺失');
    }
    if (Number(chapter.bytes || 0) <= 0) {
      warnings.push('章节正文文件为空');
    }
    if (chapter.chapterNumber) {
      if (seenNumbers.has(chapter.chapterNumber)) {
        warnings.push(`本次队列中章节号重复：第${chapter.chapterNumber}章，已出现于 ${seenNumbers.get(chapter.chapterNumber)}`);
      } else {
        seenNumbers.set(chapter.chapterNumber, chapter.file);
      }
    }
    if (Number.isFinite(numericNumber)) {
      if (previousNumber !== null && numericNumber <= previousNumber) {
        warnings.push(`章节号顺序倒退或重复：上一章 ${previousNumber}，当前 ${numericNumber}`);
      } else if (previousNumber !== null && numericNumber !== previousNumber + 1) {
        warnings.push(`章节号不连续：上一章 ${previousNumber}，当前 ${numericNumber}`);
      }
      previousNumber = numericNumber;
    }

    if (warnings.length > 0) {
      warningsByFile.set(chapter.file, warnings);
    }
  }

  return warningsByFile;
}

function findChapterState(publishConfig, chapter) {
  publishConfig.chapters.items = Array.isArray(publishConfig.chapters.items) ? publishConfig.chapters.items : [];
  let state = publishConfig.chapters.items.find((item) => item.file === chapter.file);
  if (!state) {
    state = {
      index: chapter.index,
      chapterNumber: chapter.chapterNumber,
      title: chapter.title,
      volume: chapter.volume,
      file: chapter.file,
      sha1: chapter.sha1,
      bytes: chapter.bytes,
      status: 'pending',
      attempts: 0
    };
    publishConfig.chapters.items.push(state);
  }
  return state;
}

async function createPublishSession({ page, context, novelName, useConsoleChoice = false }) {
  console.log(`正在进入番茄后台：${novelName}`);
  await page.goto(BOOK_MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3000);
  await assertStillLoggedIn(page);
  await dismissPlatformPopups(page);

  const resolvedNovelName = await openChapterManage(page, novelName, { useConsoleChoice });
  await page.waitForTimeout(4000);

  const chapterManagePage = getNewestPage(context, page);
  await assertStillLoggedIn(chapterManagePage);
  await dismissPlatformPopups(chapterManagePage);

  console.log(`本次命令将复用作品《${resolvedNovelName}》的章节管理页。`);
  return {
    context,
    page,
    chapterManagePage,
    novelName: resolvedNovelName,
    useConsoleChoice,
    volumeSelectionDone: false,
    selectedVolume: '',
    previousEditorPage: null
  };
}

async function publishOneChapter({ session, chapter, content, targetVolume, stopBeforeConfirm = false, saveDraftOnly = false, warnings = [], preferredMenuAfterChapter = null }) {
  const { context, page, chapterManagePage } = session;
  await chapterManagePage.bringToFront().catch(() => {});
  await assertStillLoggedIn(chapterManagePage);
  await dismissPlatformPopups(chapterManagePage);
  await confirmChapterWarnings(session, chapter, warnings);

  const originalPageCount = context.pages().length;
  await openChapterEditor(session, chapter);
  await page.waitForTimeout(4000);
  let editorPage = context.pages().length > originalPageCount ? context.pages().at(-1) : getNewestPage(context, chapterManagePage);

  await clearEditorGuides(editorPage);
  await dismissPlatformPopups(editorPage);

  await ensureSessionVolume({
    session,
    page: editorPage,
    targetVolume
  });

  await fillChapterEditor(editorPage, chapter, content);
  await assertEditorContentReady(editorPage, content);
  if (saveDraftOnly) {
    await saveDraftChapter(editorPage);
    await restoreChapterManagePage({
      chapterManagePage,
      editorPage,
      preferredMenu: preferredMenuAfterChapter,
      keepEditorPageOpen: true
    });
    await closePreviousEditorPage(session, editorPage);
    return;
  }
  await submitChapter(editorPage, {
    stopBeforeConfirm,
    useConsoleChoice: session.useConsoleChoice
  });
  await restoreChapterManagePage({
    chapterManagePage,
    editorPage,
    preferredMenu: preferredMenuAfterChapter,
    keepEditorPageOpen: true
  });
  await closePreviousEditorPage(session, editorPage);
}

async function closePreviousEditorPage(session, currentEditorPage) {
  const previous = session.previousEditorPage;
  if (previous && previous !== currentEditorPage && previous !== session.chapterManagePage && !previous.isClosed()) {
    await previous.close().catch(() => {});
  }
  session.previousEditorPage = currentEditorPage;
}

async function assertStillLoggedIn(page) {
  const currentUrl = page.url();
  const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
  if (/login|passport|sso/i.test(currentUrl) || /扫码登录|验证码登录|手机号登录|请登录/.test(bodyText)) {
    throw new Error('番茄登录状态已失效，请先执行 `fanqie login --force` 重新登录。');
  }
}

async function showBrowserChoiceDialog(page, { title, message, options }) {
  return page.evaluate(({ title, message, options }) => new Promise((resolve) => {
    const oldDialog = document.getElementById('fanqie-cli-choice-dialog');
    if (oldDialog) {
      oldDialog.remove();
    }

    const overlay = document.createElement('div');
    overlay.id = 'fanqie-cli-choice-dialog';
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:2147483647',
      'background:rgba(15,23,42,.42)',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif'
    ].join(';');

    const panel = document.createElement('div');
    panel.style.cssText = [
      'width:min(560px,calc(100vw - 48px))',
      'background:#fff',
      'border-radius:10px',
      'box-shadow:0 24px 80px rgba(15,23,42,.28)',
      'padding:22px',
      'color:#111827'
    ].join(';');

    const heading = document.createElement('div');
    heading.textContent = title;
    heading.style.cssText = 'font-size:18px;font-weight:700;margin-bottom:10px;';

    const body = document.createElement('div');
    body.textContent = message;
    body.style.cssText = 'font-size:14px;line-height:1.7;color:#374151;margin-bottom:18px;white-space:pre-wrap;';

    const actions = document.createElement('div');
    actions.style.cssText = 'display:grid;gap:10px;';

    for (const option of options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = option.label;
      const danger = option.kind === 'danger';
      const secondary = option.kind === 'secondary';
      const warning = option.kind === 'warning';
      button.style.cssText = [
        'width:100%',
        'border:0',
        'border-radius:8px',
        'padding:11px 14px',
        'font-size:14px',
        'font-weight:600',
        'cursor:pointer',
        danger ? 'background:#dc2626;color:#fff' : warning ? 'background:#2563eb;color:#fff' : secondary ? 'background:#e5e7eb;color:#111827' : 'background:#f97316;color:#fff'
      ].join(';');
      button.addEventListener('click', () => {
        const value = option.value;
        overlay.remove();
        resolve(value);
      });
      actions.appendChild(button);
    }

    panel.appendChild(heading);
    panel.appendChild(body);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    document.body.appendChild(overlay);
  }), { title, message, options });
}

async function chooseInteraction(session, choiceConfig) {
  if (session.useConsoleChoice) {
    return promptChoice(choiceConfig);
  }
  return showBrowserChoiceDialog(session.chapterManagePage || session.page, choiceConfig);
}

async function confirmChapterWarnings(session, chapter, warnings) {
  if (!warnings.length) {
    return;
  }

  const choice = await chooseInteraction(session, {
    title: '章节信息可能错乱',
    message: [
      `当前章节：第${chapter.chapterNumber || chapter.index}章 ${chapter.title || ''}`,
      `文件：${chapter.file}`,
      '',
      '发现以下问题：',
      ...warnings.map((warning) => `- ${warning}`),
      '',
      '请选择继续处理本章，或取消本次任务。'
    ].join('\n'),
    options: [
      {
        label: '继续处理本章',
        value: 'continue'
      },
      {
        label: '取消本次任务',
        value: 'cancel',
        kind: 'danger'
      }
    ]
  });

  if (choice === 'cancel') {
    throw new OperationCancelledError(`用户取消处理疑似错乱章节：${chapter.file}`);
  }
}

async function openChapterManage(page, novelName, { useConsoleChoice = false } = {}) {
  if (await clickChapterManageForNovel(page, novelName)) {
    return novelName;
  }

  const candidates = await collectRecentBookChoices(page);
  if (candidates.length === 0) {
    throw new OperationCancelledError(`未找到小说《${novelName}》，且无法提取候选作品列表。`);
  }

  const choiceConfig = {
    title: '未找到配置中的小说',
    message: `当前配置小说名：${novelName}\n请选择本次要操作的作品，或取消本次任务。`,
    options: [
      ...candidates.map((candidate) => ({
        label: candidate,
        value: candidate
      })),
      {
        label: '取消本次任务',
        value: '__cancel__',
        kind: 'danger'
      }
    ]
  };
  const selected = useConsoleChoice
    ? await promptChoice(choiceConfig)
    : await showBrowserChoiceDialog(page, choiceConfig);

  if (selected === '__cancel__') {
    throw new OperationCancelledError('用户取消选择作品。');
  }

  if (!(await clickChapterManageForNovel(page, selected))) {
    throw new OperationCancelledError(`未能进入所选作品《${selected}》的章节管理。`);
  }
  return selected;
}

async function clickChapterManageForNovel(page, novelName) {
  let clicked = false;
  const bookCards = page.locator('div, li, section, article').filter({ hasText: novelName });
  const cardCount = await bookCards.count();
  for (let i = cardCount - 1; i >= 0; i -= 1) {
    const card = bookCards.nth(i);
    try {
      if (!(await card.isVisible())) {
        continue;
      }
      await card.hover({ timeout: 3000 });
      await page.waitForTimeout(1000);
      const manageButton = card.getByText('章节管理').first();
      if (await manageButton.isVisible()) {
        await manageButton.click({ force: true });
        clicked = true;
        break;
      }
    } catch {
      // 当前卡片不可用时继续尝试下一个候选卡片。
    }
  }

  if (!clicked) {
    const allCards = page.locator('[class*="book"], [class*="card"], [class*="item"]').filter({ hasText: novelName });
    const allCount = await allCards.count();
    for (let i = 0; i < allCount; i += 1) {
      try {
        const card = allCards.nth(i);
        if (!(await card.isVisible())) {
          continue;
        }
        await card.hover({ timeout: 2000 });
        await page.waitForTimeout(800);
        const scopedButton = card.getByText('章节管理').first();
        if (await scopedButton.isVisible()) {
          await scopedButton.click({ force: true });
          clicked = true;
          break;
        }
      } catch {
        // 当前卡片不可用时继续尝试下一个候选卡片。
      }
    }
  }

  return clicked;
}

async function collectRecentBookChoices(page) {
  const names = await page.evaluate(() => {
    const blockedExactTexts = new Set([
      '我的小说',
      '征文活动',
      '创建作品发布章节',
      '创建作品',
      '发布章节',
      '收起',
      '展开',
      '章节管理',
      '作品管理',
      '新建作品',
      '工作台',
      '番茄',
      '更多',
      '编辑',
      '删除',
      '查看数据',
      '作品设置'
    ]);
    const blockedIncludes = [
      '征文',
      '活动',
      '创建作品',
      '发布章节',
      '收起',
      '展开'
    ];
    const bookNameHints = [
      '[class*="name"]',
      '[class*="title"]',
      '[class*="book-name"]',
      '[class*="bookName"]',
      '[class*="work-name"]',
      '[class*="workName"]',
      'h1',
      'h2',
      'h3',
      'h4'
    ];
    const cardSelectors = [
      '[class*="book"][class*="card"]',
      '[class*="book"][class*="item"]',
      '[class*="work"][class*="card"]',
      '[class*="work"][class*="item"]',
      '[class*="novel"][class*="card"]',
      '[class*="novel"][class*="item"]'
    ];

    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function looksLikeBookName(value) {
      const text = cleanText(value);
      if (text.length < 2 || text.length > 30) {
        return false;
      }
      if (blockedExactTexts.has(text)) {
        return false;
      }
      if (blockedIncludes.some((item) => text.includes(item))) {
        return false;
      }
      if (/^(全部|连载中|已完结|审核|草稿|共\d+|更新|更多|管理|操作)/.test(text)) {
        return false;
      }
      return /[\u4e00-\u9fa5A-Za-z0-9]/.test(text);
    }

    function extractNameFromCard(card) {
      for (const selector of bookNameHints) {
        for (const node of card.querySelectorAll(selector)) {
          const text = cleanText(node.textContent);
          if (looksLikeBookName(text)) {
            return text;
          }
        }
      }

      const lines = cleanText(card.innerText).split(' ')
        .map((line) => cleanText(line))
        .filter(Boolean);
      return lines.find((line) => looksLikeBookName(line)) || '';
    }

    const result = [];
    const seen = new Set();

    for (const selector of cardSelectors) {
      for (const card of document.querySelectorAll(selector)) {
        const cardText = cleanText(card.innerText);
        const hasBookAction = cardText.includes('章节管理') || cardText.includes('数据') || cardText.includes('编辑');
        if (!hasBookAction) {
          continue;
        }
        const text = extractNameFromCard(card);
        if (!text || seen.has(text)) {
          continue;
        }
        seen.add(text);
        result.push(text);
        if (result.length >= 5) {
          return result;
        }
      }
    }
    return result;
  });
  return names.slice(0, 5);
}

async function restoreChapterManagePage({ chapterManagePage, editorPage, preferredMenu, keepEditorPageOpen = false }) {
  try {
    if (editorPage !== chapterManagePage && !editorPage.isClosed()) {
      if (!keepEditorPageOpen) {
        await editorPage.close().catch(() => {});
      }
      await chapterManagePage.bringToFront().catch(() => {});
    } else {
      await returnFromSamePageEditor(chapterManagePage);
    }
    await chapterManagePage.waitForTimeout(1200);
    if (preferredMenu) {
      await selectChapterManageMenu(chapterManagePage, preferredMenu);
    }
  } catch (error) {
    console.log(`页面收尾未完全完成：${error.message}`);
  }
}

async function returnFromSamePageEditor(page) {
  for (const text of ['返回', '章节管理', '返回章节管理']) {
    const target = page.getByText(text, { exact: false }).first();
    if (await target.isVisible().catch(() => false)) {
      await target.click({ force: true }).catch(() => {});
      await page.waitForTimeout(1200);
      return;
    }
  }
  await page.goBack({ waitUntil: 'domcontentloaded', timeout: 8000 }).catch(() => {});
}

async function selectChapterManageMenu(page, preferredMenu) {
  const texts = preferredMenu === 'drafts'
    ? ['草稿箱', '草稿']
    : ['章节管理', '全部章节', '已发布'];

  for (const text of texts) {
    const roleTab = page.getByRole('tab', { name: text }).first();
    if (await roleTab.isVisible().catch(() => false)) {
      await roleTab.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      return;
    }

    const roleButton = page.getByRole('button', { name: text }).first();
    if (await roleButton.isVisible().catch(() => false)) {
      await roleButton.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      return;
    }

    const textNode = page.getByText(text, { exact: false }).first();
    if (await textNode.isVisible().catch(() => false)) {
      await textNode.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      return;
    }
  }
}

async function openChapterEditor(session, chapter) {
  const page = session.chapterManagePage;
  const chapterNumber = chapter.chapterNumber || String(chapter.index);
  const draftRow = page.locator('tr, li, .chapter-item').filter({
    hasText: new RegExp(`第\\s*${escapeRegExp(chapterNumber)}\\s*章`)
  }).first();

  if (await draftRow.isVisible()) {
    const choice = await chooseInteraction(session, {
      title: '检测到重复章节',
      message: `后台已存在“第${chapterNumber}章”相关记录。\n当前文件：${chapter.file}\n请选择如何处理。`,
      options: [
        {
          label: '覆盖/继续编辑已有章节',
          value: 'overwrite'
        },
        {
          label: '排除本章，继续后续任务',
          value: 'skip',
          kind: 'secondary'
        },
        {
          label: '取消本次任务',
          value: 'cancel',
          kind: 'danger'
        }
      ]
    });

    if (choice === 'skip') {
      throw new ChapterSkippedError(`用户选择跳过重复章节：第${chapterNumber}章`);
    }
    if (choice === 'cancel') {
      throw new OperationCancelledError(`用户取消处理重复章节：第${chapterNumber}章`);
    }

    console.log(`检测到已有记录，进入编辑覆盖：第${chapterNumber}章`);
    const editIcon = draftRow.locator('td').last().locator('svg, i, a, span, button, img').first();
    if (await editIcon.isVisible()) {
      await editIcon.click({ force: true });
    } else {
      await draftRow.click({ force: true });
    }
    return;
  }

  const createButtonByRole = page.getByRole('button', { name: '新建章节' }).first();
  if (await createButtonByRole.isVisible()) {
    await createButtonByRole.click({ force: true });
    return;
  }

  const createButtonByText = page.getByText('新建章节').first();
  if (await createButtonByText.isVisible()) {
    await createButtonByText.click({ force: true });
    return;
  }

  throw new Error('未找到“新建章节”按钮。');
}

async function clearEditorGuides(page) {
  for (let i = 0; i < 3; i += 1) {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForTimeout(200);
  }

  for (let i = 0; i < 10; i += 1) {
    let clickedGuide = false;
    for (const text of ['下一步', '完成', '我知道了', '跳过']) {
      const handles = await page.getByText(text, { exact: true }).elementHandles().catch(() => []);
      for (const handle of handles) {
        const box = await handle.boundingBox().catch(() => null);
        if (box && box.y > 100) {
          await handle.click({ force: true }).catch(() => {});
          await page.waitForTimeout(600);
          clickedGuide = true;
        }
      }
    }
    if (!clickedGuide) {
      break;
    }
  }
}

async function dismissPlatformPopups(page) {
  let dismissed = false;
  for (const text of ['我知道了', '知道了', '关闭', '跳过', '完成']) {
    const button = page.getByText(text, { exact: true }).first();
    try {
      if (await button.isVisible()) {
        await button.click({ force: true });
        await page.waitForTimeout(500);
        dismissed = true;
      }
    } catch {
      // 当前文案不可用时继续尝试其他弹窗文案。
    }
  }
  return dismissed;
}

async function selectVolume(page, targetVolume, { useConsoleChoice = false } = {}) {
  const dialogOpened = await openVolumeDialog(page);
  if (!dialogOpened) {
    throw new Error('未能打开分卷选择弹窗');
  }

  const candidates = [targetVolume, targetVolume.replace(/[一二三四五六七八九十百]+/, extractArabicVolume(targetVolume)), `卷${extractArabicVolume(targetVolume)}`].filter(Boolean);
  for (const volumeName of candidates) {
    if (await chooseVolumeInOpenDialog(page, volumeName)) {
      return volumeName;
    }
  }

  if (useConsoleChoice) {
    const availableVolumes = await collectOpenDialogVolumeChoices(page);
    if (availableVolumes.length === 0) {
      await closeVolumeDialogIfOpen(page);
      throw new OperationCancelledError(`分卷弹窗中未找到 ${targetVolume}，且无法提取可选分卷列表。`);
    }

    const selectedVolume = await promptChoice({
      title: '未找到目标分卷',
      message: `本地章节目标分卷：${targetVolume}\n请选择本次要使用的后台分卷，或取消本次任务。`,
      options: [
        ...availableVolumes.map((volumeName) => ({
          label: volumeName,
          value: volumeName
        })),
        {
          label: '取消本次任务',
          value: '__cancel__',
          kind: 'danger'
        }
      ]
    });

    if (selectedVolume === '__cancel__') {
      await closeVolumeDialogIfOpen(page);
      throw new OperationCancelledError('用户取消选择分卷。');
    }
    if (!(await chooseVolumeInOpenDialog(page, selectedVolume))) {
      await closeVolumeDialogIfOpen(page);
      throw new OperationCancelledError(`未能选择分卷：${selectedVolume}`);
    }
    return selectedVolume;
  }

  console.log(`分卷弹窗中未找到包含 ${targetVolume} 的选项，请在浏览器中手动选择目标卷并确定。等待 20 秒...`);
  await page.waitForTimeout(20000);
  await closeVolumeDialogIfOpen(page);
  return targetVolume;
}

async function selectVolumeSilently(page, targetVolume) {
  const dialogOpened = await openVolumeDialog(page);
  if (!dialogOpened) {
    throw new Error('未能打开分卷选择弹窗');
  }
  if (await chooseVolumeInOpenDialog(page, targetVolume)) {
    return;
  }
  await page.keyboard.press('Escape').catch(() => {});
  throw new Error(`未能静默选择分卷：${targetVolume}`);
}

async function openVolumeDialog(page) {
  const volumeElements = await page.getByText(/第[一二三四五六七八九十百0-9]+卷/).elementHandles();
  for (const element of volumeElements.slice(0, 8)) {
    const box = await element.boundingBox().catch(() => null);
    if (!box || box.y < 0 || box.y > 800) {
      continue;
    }
    const outerHtml = await element.evaluate((el) => el.outerHTML).catch(() => '');
    if (/outline|placeholder|卷名/i.test(outerHtml)) {
      continue;
    }
    await element.click({ force: true });
    await page.waitForTimeout(1000);
    if (await page.getByText('新建分卷').isVisible().catch(() => false) || await page.getByText('取消').first().isVisible().catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function chooseVolumeInOpenDialog(page, volumeName) {
  const handles = await page.getByText(volumeName, { exact: false }).elementHandles().catch(() => []);
  for (const handle of handles) {
    const box = await handle.boundingBox().catch(() => null);
    const outerHtml = await handle.evaluate((el) => el.outerHTML).catch(() => '');
    if (!box || box.y < 0 || box.y > 800 || /outline|placeholder|卷名/i.test(outerHtml)) {
      continue;
    }
    await handle.click({ force: true });
    await page.waitForTimeout(500);
    const confirmButton = page.getByRole('button', { name: '确定' }).first();
    if (await confirmButton.isVisible()) {
      await confirmButton.click({ force: true });
    } else {
      await page.keyboard.press('Escape');
    }
    await page.waitForTimeout(1000);
    return true;
  }
  return false;
}

async function collectOpenDialogVolumeChoices(page) {
  const volumes = await page.evaluate(() => {
    const result = [];
    const seen = new Set();
    const selectors = [
      '[role="dialog"] *',
      '.ant-modal *',
      '.semi-modal *',
      '.byte-modal *',
      'body *'
    ];

    function cleanText(value) {
      return String(value || '').replace(/\s+/g, ' ').trim();
    }

    function looksLikeVolumeName(text) {
      if (text.length < 2 || text.length > 24) {
        return false;
      }
      if (/新建分卷|取消|确定|确认|请输入|卷名/.test(text)) {
        return false;
      }
      return /第[一二三四五六七八九十百0-9]+卷|卷\s*[0-9一二三四五六七八九十百]+/.test(text);
    }

    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        const rect = node.getBoundingClientRect();
        if (!rect || rect.width <= 0 || rect.height <= 0 || rect.top < 0 || rect.top > window.innerHeight) {
          continue;
        }
        const text = cleanText(node.textContent);
        if (!looksLikeVolumeName(text) || seen.has(text)) {
          continue;
        }
        seen.add(text);
        result.push(text);
        if (result.length >= 20) {
          return result;
        }
      }
    }
    return result;
  }).catch(() => []);
  return volumes;
}

async function ensureSessionVolume({ session, page, targetVolume }) {
  const normalizedTargetVolume = normalizeVolumeName(targetVolume);
  if (!normalizedTargetVolume || normalizedTargetVolume === '第1卷') {
    session.volumeSelectionDone = true;
    session.selectedVolume = normalizedTargetVolume;
    return;
  }

  if (!session.volumeSelectionDone) {
    const selectedVolume = await selectVolume(page, normalizedTargetVolume, {
      useConsoleChoice: session.useConsoleChoice
    });
    session.volumeSelectionDone = true;
    session.selectedVolume = selectedVolume;
    console.log(`本次命令将复用分卷：${selectedVolume}`);
    return;
  }

  if (session.selectedVolume) {
    await selectVolumeSilently(page, session.selectedVolume).catch((error) => {
      console.log(`静默选择分卷失败，将保持当前编辑页分卷：${error.message}`);
    });
  }
}

async function closeVolumeDialogIfOpen(page) {
  try {
    if (await page.getByText('取消').first().isVisible()) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
  } catch {
    // 分卷弹窗不存在或已被手动关闭时无需处理。
  }
}

async function fillChapterEditor(page, chapter, content) {
  if (!content || !content.trim()) {
    throw new OperationCancelledError(`章节正文为空，已阻止继续处理：${chapter.file}`);
  }

  const chapterNumber = chapter.chapterNumber || String(chapter.index);
  const numberInput = page.locator('input[type="text"]').first();
  if (await numberInput.isVisible()) {
    await numberInput.fill(chapterNumber, { force: true });
  }

  let titleInput = page.getByPlaceholder('请输入标题', { exact: false }).first();
  if (!(await titleInput.isVisible())) {
    titleInput = page.getByPlaceholder('请输入章节名', { exact: false }).first();
  }
  if (!(await titleInput.isVisible())) {
    titleInput = page.locator('input[type="text"]').last();
  }
  if (await titleInput.isVisible()) {
    await titleInput.fill(chapter.title, { force: true });
  }

  let editor = page.locator('.ql-editor').first();
  if (!(await editor.isVisible())) {
    editor = page.locator('.ProseMirror').first();
  }
  if (!(await editor.isVisible())) {
    editor = page.locator('[contenteditable="true"]').first();
  }
  if (!(await editor.isVisible())) {
    throw new Error('未找到正文编辑器。');
  }

  await editor.click({ force: true });
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
  await page.keyboard.press('Backspace');

  if (await fillEditorByLocator(page, editor, content)) {
    return;
  }

  if (await pasteEditorByClipboard(page, editor, content)) {
    return;
  }

  await injectEditorByDom(page, editor, content);
  await waitUntilEditorTextMatches(page, content);
}

async function fillEditorByLocator(page, editor, content) {
  try {
    await editor.fill(content, { timeout: 10000 });
    await nudgeEditorInput(page, editor);
    await page.waitForTimeout(800);
    return await isEditorTextReady(page, content);
  } catch {
    return false;
  }
}

async function pasteEditorByClipboard(page, editor, content) {
  try {
    const origin = new URL(page.url()).origin;
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin }).catch(() => {});
    await page.evaluate(async (text) => {
      await navigator.clipboard.writeText(text);
    }, content);
    await editor.click({ force: true });
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.keyboard.press('Backspace');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+V' : 'Control+V');
    await nudgeEditorInput(page, editor);
    await page.waitForTimeout(1200);
    return await isEditorTextReady(page, content);
  } catch {
    return false;
  }
}

async function injectEditorByDom(page, editor, content) {
  const editorHandle = await editor.elementHandle();
  await page.evaluate(([element, text]) => {
    element.focus();
    element.textContent = '';

    if (element.classList.contains('ProseMirror')) {
      const paragraphs = text.split(/\n{2,}|\n/).map((line) => line || ' ');
      for (const line of paragraphs) {
        const paragraph = document.createElement('p');
        paragraph.textContent = line;
        element.appendChild(paragraph);
      }
    } else {
      element.innerText = text;
    }

    element.dispatchEvent(new InputEvent('beforeinput', {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: text.slice(0, 1)
    }));
    element.dispatchEvent(new InputEvent('input', {
      bubbles: true,
      inputType: 'insertText',
      data: text.slice(0, 1)
    }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    element.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Process' }));
  }, [editorHandle, content]);
  await editor.click({ force: true });
  await nudgeEditorInput(page, editor);
}

async function nudgeEditorInput(page, editor) {
  await editor.click({ force: true });
  await page.keyboard.press('End');
  await page.keyboard.press('Space');
  await page.waitForTimeout(250);
  await page.keyboard.press('Backspace');
}

async function assertEditorContentReady(page, expectedContent) {
  if (!(await isEditorTextReady(page, expectedContent))) {
    throw new Error('正文写入编辑器后校验失败，已阻止点击下一步/存草稿，避免发布 0 字章节。');
  }
}

async function waitUntilEditorTextMatches(page, expectedContent) {
  const ok = await page.waitForFunction((expected) => {
    const editor = document.querySelector('.ql-editor, .ProseMirror, [contenteditable="true"]');
    const actual = normalizeEditorText(editor?.innerText || editor?.textContent || '');
    const target = normalizeEditorText(expected);
    return isReady(actual, target);

    function normalizeEditorText(value) {
      return String(value || '').replace(/\s+/g, '');
    }
    function isReady(actualText, targetText) {
      if (!targetText || !actualText) {
        return false;
      }
      if (targetText.length <= 30) {
        return actualText.includes(targetText);
      }
      const threshold = Math.max(30, Math.floor(targetText.length * 0.9));
      return actualText.length >= threshold || actualText.includes(targetText.slice(0, 80));
    }
  }, expectedContent, { timeout: 5000 }).then(() => true).catch(() => false);

  if (!ok) {
    throw new Error('正文写入编辑器后未能通过可见文本校验。');
  }
}

async function isEditorTextReady(page, expectedContent) {
  return page.evaluate((expected) => {
    const editor = document.querySelector('.ql-editor, .ProseMirror, [contenteditable="true"]');
    const actual = normalizeEditorText(editor?.innerText || editor?.textContent || '');
    const target = normalizeEditorText(expected);
    if (!target) {
      return false;
    }
    if (!actual) {
      return false;
    }
    if (target.length <= 30) {
      return actual.includes(target);
    }
    const threshold = Math.max(30, Math.floor(target.length * 0.9));
    return actual.length >= threshold || actual.includes(target.slice(0, 80));

    function normalizeEditorText(value) {
      return String(value || '').replace(/\s+/g, '');
    }
  }, expectedContent).catch(() => false);
}

async function submitChapter(page, { stopBeforeConfirm = false, useConsoleChoice = false } = {}) {
  const nextButton = page.getByText('下一步', { exact: true }).last();
  if (!(await nextButton.isVisible())) {
    const saveButton = page.getByText('存草稿', { exact: false }).first();
    if (await saveButton.isVisible()) {
      await saveButton.click({ force: true });
      throw new Error('未找到“下一步”，章节已降级保存为草稿，未确认发布。');
    }
    throw new Error('未找到“下一步”或“存草稿”按钮。');
  }

  await nextButton.click({ force: true });
  await page.waitForTimeout(2000);

  for (let attempt = 0; attempt < 18; attempt += 1) {
    await clickAiNoIfVisible(page);

    const publishButton = page.getByRole('button', { name: '确认发布' }).first();
    const publishText = page.getByText('确认发布', { exact: true }).first();
    if (await publishButton.isVisible().catch(() => false) && await publishButton.isEnabled().catch(() => false)) {
      if (stopBeforeConfirm) {
        console.log('已停在“确认发布”按钮出现的位置，请在浏览器中手动点击取消。');
        await promptEnter('手动取消后，回到终端按回车继续：');
        return;
      }
      await publishButton.click({ force: true });
      await page.waitForTimeout(6000);
      return;
    }
    if (await publishText.isVisible().catch(() => false)) {
      if (stopBeforeConfirm) {
        console.log('已停在“确认发布”页面/弹框，请在浏览器中手动点击取消。');
        await promptEnter('手动取消后，回到终端按回车继续：');
        return;
      }
      await publishText.click({ force: true });
      await page.waitForTimeout(6000);
      return;
    }

    const handledPopup = await handlePublishPopup(page);
    if (!handledPopup) {
      await page.waitForTimeout(1000);
    }
  }

  if (stopBeforeConfirm) {
    if (useConsoleChoice) {
      throw new Error('无头浏览器模式无法停在最终“确认发布”面板供手动检查。');
    }
    await promptEnter('未自动匹配到“确认发布”，浏览器已暂停。请手动检查并取消后，按回车继续：');
    return;
  }

  if (useConsoleChoice) {
    throw new Error('未自动匹配到最后的“确认发布”，无头浏览器模式下无法手动确认。');
  }
  await promptEnter('未自动匹配到最后的“确认发布”。请在浏览器中手动确认发布完成后，按回车继续：');
}

async function saveDraftChapter(page) {
  const buttonNames = [/存草稿|保存草稿|保存为草稿/];
  for (const name of buttonNames) {
    const roleButton = page.getByRole('button', { name }).last();
    if (await roleButton.isVisible().catch(() => false) && await roleButton.isEnabled().catch(() => false)) {
      await roleButton.click({ force: true });
      await waitForDraftSaved(page);
      return;
    }
  }

  for (const text of ['存草稿', '保存草稿', '保存为草稿']) {
    const textButton = page.getByText(text, { exact: false }).last();
    if (await textButton.isVisible().catch(() => false)) {
      await textButton.click({ force: true });
      await waitForDraftSaved(page);
      return;
    }
  }

  throw new Error('未找到“存草稿”按钮。');
}

async function waitForDraftSaved(page) {
  await page.waitForTimeout(6000);
  for (const text of ['保存成功', '已保存', '草稿已保存', '存草稿成功']) {
    const notice = page.getByText(text, { exact: false }).first();
    if (await notice.isVisible().catch(() => false)) {
      await page.waitForTimeout(800);
      return;
    }
  }
}

async function clickAiNoIfVisible(page) {
  const aiNoLabel = page.getByText('否', { exact: true }).first();
  if (await aiNoLabel.isVisible().catch(() => false)) {
    await aiNoLabel.click({ force: true }).catch(() => {});
    await page.waitForTimeout(500);
  }
}

async function handlePublishPopup(page) {
  for (const text of ['提交', '继续发布', '我知道了', '确认', '确定']) {
    const roleButton = page.getByRole('button', { name: text }).last();
    if (await roleButton.isVisible().catch(() => false) && await roleButton.isEnabled().catch(() => false)) {
      await roleButton.click({ force: true });
      await page.waitForTimeout(1000);
      return true;
    }

    const textButton = page.getByText(text, { exact: true }).last();
    if (await textButton.isVisible().catch(() => false)) {
      await textButton.click({ force: true });
      await page.waitForTimeout(1000);
      return true;
    }
  }
  return false;
}

function getNewestPage(context, fallbackPage) {
  return context.pages().at(-1) || fallbackPage;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractArabicVolume(value) {
  const match = String(value).match(/\d+/);
  return match ? match[0] : '';
}
