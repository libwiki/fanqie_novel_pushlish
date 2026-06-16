import fs from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';
import {
  CONFIG_FILE_NAME,
  DEFAULT_IGNORE_DIRS,
  DEFAULT_IGNORE_FILES,
  DEFAULT_PUBLISH_COUNT,
  DEFAULT_SCAN_EXTENSIONS,
  LEGACY_PUBLISH_FILE_NAME,
  PUBLISH_FILE_NAME,
  PUB_CONFIG_FILE_NAME
} from './constants.js';
import { nowIso, pathExists } from './io.js';

export async function findConfigPath(startDir = process.cwd()) {
  let current = path.resolve(startDir);
  while (true) {
    const candidate = path.join(current, CONFIG_FILE_NAME);
    if (await pathExists(candidate)) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

export async function readYamlFile(filePath, fallback = {}) {
  if (!(await pathExists(filePath))) {
    return fallback;
  }
  const content = await fs.readFile(filePath, 'utf8');
  return YAML.parse(content) ?? fallback;
}

export async function writeYamlFile(filePath, data) {
  const content = YAML.stringify(data, {
    lineWidth: 0,
    singleQuote: false
  });
  await fs.writeFile(filePath, content, 'utf8');
}

export async function loadProjectConfig(startDir = process.cwd()) {
  const configPath = await findConfigPath(startDir);
  if (!configPath) {
    throw new Error(`未找到 ${CONFIG_FILE_NAME}，请先在小说目录执行 \`fanqie init\`。`);
  }

  const rootDir = path.dirname(configPath);
  const pubConfigPath = getPubConfigPath(rootDir);
  const legacyPublishPath = path.join(rootDir, LEGACY_PUBLISH_FILE_NAME);
  const userConfig = await readYamlFile(configPath);
  const pubConfig = await readYamlFile(pubConfigPath, {});
  const legacyPublishConfig = await readYamlFile(legacyPublishPath, {});
  const config = normalizeProjectConfig(userConfig, rootDir, pubConfig, legacyPublishConfig);

  return {
    configPath,
    pubConfigPath,
    rootDir,
    config
  };
}

export function createDefaultProjectConfig({ rootDir, novelName, summary, extensions }) {
  return normalizeUserProjectConfig({
    version: 1,
    novel: {
      name: novelName || path.basename(rootDir),
      summary: summary || ''
    },
    scan: {
      root: '.',
      extensions: extensions?.length ? extensions : DEFAULT_SCAN_EXTENSIONS,
      ignoreFiles: DEFAULT_IGNORE_FILES,
      ignoreDirs: DEFAULT_IGNORE_DIRS
    },
    browser: {
      headless: false
    },
    updatedAt: nowIso()
  }, rootDir);
}

export function createDefaultPubConfig({ currentVolume } = {}) {
  return normalizePubConfig({
    version: 1,
    currentVolume: currentVolume || '第1卷',
    publish: {
      defaultCount: DEFAULT_PUBLISH_COUNT,
      progress: createEmptyPublishProgress()
    },
    chapters: {
      count: 0,
      items: []
    },
    updatedAt: nowIso()
  });
}

export function normalizeProjectConfig(userConfig, rootDir, pubConfig = {}, legacyPublishConfig = {}) {
  const normalizedUserConfig = normalizeUserProjectConfig(userConfig, rootDir);
  const legacyPublicConfig = extractLegacyPubConfig(userConfig);
  const normalizedPubConfig = normalizePubConfig({
    ...legacyPublicConfig,
    ...pubConfig,
    publish: {
      ...legacyPublicConfig.publish,
      ...pubConfig.publish
    },
    chapters: pubConfig.chapters || legacyPublicConfig.chapters,
    legacyPublishConfig
  });

  return {
    ...normalizedUserConfig,
    currentVolume: normalizedPubConfig.currentVolume,
    publish: normalizedPubConfig.publish,
    chapters: normalizedPubConfig.chapters,
    updatedAt: normalizedPubConfig.updatedAt
  };
}

export function normalizeUserProjectConfig(config, rootDir) {
  return {
    version: config.version ?? 1,
    novel: {
      name: config.novel?.name || path.basename(rootDir),
      summary: config.novel?.summary || ''
    },
    scan: {
      root: config.scan?.root || '.',
      extensions: normalizeExtensions(config.scan?.extensions || DEFAULT_SCAN_EXTENSIONS),
      ignoreFiles: mergeUnique(DEFAULT_IGNORE_FILES, Array.isArray(config.scan?.ignoreFiles) ? config.scan.ignoreFiles : []),
      ignoreDirs: mergeUnique(DEFAULT_IGNORE_DIRS, Array.isArray(config.scan?.ignoreDirs) ? config.scan.ignoreDirs : [])
    },
    browser: {
      headless: normalizeBoolean(config.browser?.headless)
    },
    updatedAt: config.updatedAt || nowIso()
  };
}

export function normalizePubConfig(config = {}) {
  const legacyPublishConfig = config.legacyPublishConfig || {};
  const legacyChapters = Array.isArray(legacyPublishConfig.chapters) ? legacyPublishConfig.chapters : [];
  const chapterItems = Array.isArray(config.chapters?.items)
    ? config.chapters.items
    : legacyChapters;

  return {
    version: config.version ?? 1,
    novelName: config.novelName || legacyPublishConfig.novelName || '',
    currentVolume: config.currentVolume || legacyPublishConfig.currentVolume || '第1卷',
    publish: {
      defaultCount: Number(config.publish?.defaultCount || legacyPublishConfig.defaultCount || DEFAULT_PUBLISH_COUNT),
      lastRunId: config.publish?.lastRunId || legacyPublishConfig.lastRunId || '',
      startedAt: config.publish?.startedAt || legacyPublishConfig.startedAt || '',
      updatedAt: config.publish?.updatedAt || '',
      progress: normalizePublishProgress(config.publish?.progress || legacyPublishConfig.progress)
    },
    chapters: {
      count: Number(config.chapters?.count || chapterItems.length || 0),
      items: chapterItems
    },
    updatedAt: config.updatedAt || legacyPublishConfig.updatedAt || nowIso()
  };
}

export function toUserProjectConfig(config, rootDir) {
  return normalizeUserProjectConfig(config, rootDir);
}

export function toPubConfig(config) {
  return normalizePubConfig({
    version: config.version,
    novelName: config.novel?.name || config.novelName || '',
    currentVolume: config.currentVolume,
    publish: config.publish,
    chapters: config.chapters,
    updatedAt: config.updatedAt || nowIso()
  });
}

export function normalizeExtensions(extensions) {
  if (typeof extensions === 'string') {
    return extensions.split(',').map((item) => item.trim().replace(/^\./, '')).filter(Boolean);
  }
  return extensions.map((item) => String(item).trim().replace(/^\./, '')).filter(Boolean);
}

function mergeUnique(defaultItems, customItems) {
  return [...new Set([...defaultItems, ...customItems])];
}

function normalizeBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value.trim().toLowerCase() === 'true';
  }
  return Boolean(value);
}

export function getPubConfigPath(rootDir) {
  return path.join(rootDir, PUB_CONFIG_FILE_NAME);
}

export function getPublishConfigPath(rootDir) {
  return path.join(rootDir, PUBLISH_FILE_NAME);
}

export async function loadPublishConfig(rootDir) {
  const publishPath = getPublishConfigPath(rootDir);
  const legacyPublishPath = path.join(rootDir, LEGACY_PUBLISH_FILE_NAME);
  const data = await readYamlFile(publishPath, {});
  const legacyPublishConfig = await readYamlFile(legacyPublishPath, {});
  return {
    publishPath,
    publishConfig: normalizePubConfig({
      ...data,
      legacyPublishConfig
    })
  };
}

function extractLegacyPubConfig(config = {}) {
  return {
    novelName: config.novel?.name || '',
    currentVolume: config.currentVolume || '第1卷',
    publish: config.publish || {
      defaultCount: DEFAULT_PUBLISH_COUNT,
      progress: createEmptyPublishProgress()
    },
    chapters: config.chapters || {
      count: 0,
      items: []
    },
    updatedAt: config.updatedAt || nowIso()
  };
}

function normalizePublishProgress(progress = {}) {
  return {
    currentChapterNumber: normalizeNonNegativeInteger(progress.currentChapterNumber),
    missingChapterNumbers: normalizePositiveIntegerList(progress.missingChapterNumbers),
    updatedAt: progress.updatedAt || ''
  };
}

function createEmptyPublishProgress() {
  return {
    currentChapterNumber: 0,
    missingChapterNumbers: [],
    updatedAt: ''
  };
}

function normalizePositiveIntegerList(values) {
  if (!Array.isArray(values)) {
    return [];
  }
  return [...new Set(values
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0))]
    .sort((left, right) => left - right);
}

function normalizeNonNegativeInteger(value) {
  const number = Number.parseInt(value, 10);
  return Number.isInteger(number) && number > 0 ? number : 0;
}
