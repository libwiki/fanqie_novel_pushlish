import path from 'node:path';
import fg from 'fast-glob';
import fs from 'node:fs/promises';
import ignore from 'ignore';
import { buildChapterFromFile, compareChapters } from './chapter.js';
import { nowIso, toPosixPath } from './io.js';

export async function scanProject({ rootDir, config }) {
  const scanRoot = path.resolve(rootDir, config.scan.root || '.');
  const extensions = config.scan.extensions.length ? config.scan.extensions : ['txt', 'md'];
  const patterns = extensions.map((extension) => `**/*.${extension.replace(/^\./, '')}`);
  const ignore = buildIgnorePatterns(config);
  const entries = await fg(patterns, {
    cwd: scanRoot,
    onlyFiles: true,
    dot: false,
    unique: true,
    ignore
  });
  const gitignoreMatchers = await loadGitignoreMatchers(scanRoot);
  const filteredEntries = entries.filter((entry) => !isIgnoredByGitignore(entry, gitignoreMatchers));

  const chapters = [];
  const previousChapters = new Map((config.chapters?.items || []).map((chapter) => [chapter.file, chapter]));
  for (const entry of filteredEntries) {
    const filePath = path.join(scanRoot, entry);
    const chapter = await buildChapterFromFile({
      filePath,
      relativePath: toPosixPath(path.relative(rootDir, filePath)),
      rootDir: scanRoot,
      defaultVolume: config.currentVolume,
      index: chapters.length + 1
    });
    chapters.push(mergeChapterState(chapter, previousChapters.get(chapter.file)));
  }

  chapters.sort(compareChapters);
  chapters.forEach((chapter, index) => {
    chapter.index = index + 1;
  });

  return {
    ...config,
    chapters: {
      count: chapters.length,
      items: chapters
    },
    updatedAt: nowIso()
  };
}

async function loadGitignoreMatchers(scanRoot) {
  const gitignoreFiles = await fg('**/.gitignore', {
    cwd: scanRoot,
    onlyFiles: true,
    dot: true,
    unique: true,
    ignore: ['**/.git/**', '**/node_modules/**']
  });
  const matchers = [];

  for (const file of gitignoreFiles) {
    const absFile = path.join(scanRoot, file);
    const content = await fs.readFile(absFile, 'utf8').catch(() => '');
    if (!content.trim()) {
      continue;
    }
    matchers.push({
      base: path.dirname(file) === '.' ? '' : normalizeGlobPart(path.dirname(file)),
      matcher: ignore().add(content)
    });
  }

  return matchers;
}

function isIgnoredByGitignore(entry, matchers) {
  const normalizedEntry = normalizeGlobPart(entry);
  return matchers.some(({ base, matcher }) => {
    if (!base) {
      return matcher.ignores(normalizedEntry);
    }
    if (normalizedEntry !== base && !normalizedEntry.startsWith(`${base}/`)) {
      return false;
    }
    const relativeToGitignore = normalizedEntry.slice(base.length).replace(/^\//, '');
    return matcher.ignores(relativeToGitignore);
  });
}

function buildIgnorePatterns(config) {
  const ignore = [];
  for (const dir of config.scan.ignoreDirs || []) {
    const normalized = normalizeGlobPart(dir);
    ignore.push(normalized.includes('*') ? `**/${normalized}/**` : `**/${normalized}/**`);
  }
  for (const file of config.scan.ignoreFiles || []) {
    const normalized = normalizeGlobPart(file);
    ignore.push(normalized.includes('/') ? normalized : `**/${normalized}`);
  }
  return ignore;
}

function mergeChapterState(chapter, previousChapter) {
  if (!previousChapter) {
    return chapter;
  }

  if (previousChapter.sha1 && previousChapter.sha1 !== chapter.sha1) {
    return {
      ...chapter,
      status: 'pending',
      attempts: Number(previousChapter.attempts || 0),
      previousSha1: previousChapter.sha1,
      changedAt: nowIso(),
      error: ''
    };
  }

  return {
    ...chapter,
    status: previousChapter.status,
    attempts: previousChapter.attempts,
    lastRunId: previousChapter.lastRunId,
    startedAt: previousChapter.startedAt,
    publishedAt: previousChapter.publishedAt,
    failedAt: previousChapter.failedAt,
    previousSha1: previousChapter.previousSha1,
    changedAt: previousChapter.changedAt,
    error: previousChapter.error
  };
}

function normalizeGlobPart(value) {
  return String(value).replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+$/, '');
}
