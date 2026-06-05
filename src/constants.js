import os from 'node:os';
import path from 'node:path';

export const CONFIG_FILE_NAME = 'fanqie.yaml';
export const PUB_CONFIG_FILE_NAME = 'fanqie_pub.yaml';
export const LEGACY_PUBLISH_FILE_NAME = '.fanqie.publish.yaml';
export const PUBLISH_FILE_NAME = PUB_CONFIG_FILE_NAME;
export const AUTH_DIR = path.join(os.homedir(), '.fanqie-novel-publisher');
export const STATE_FILE = path.join(AUTH_DIR, 'state.json');
export const WRITER_HOME_URL = 'https://fanqienovel.com/main/writer/?enter_from=author_zone';
export const BOOK_MANAGE_URL = 'https://fanqienovel.com/main/writer/book-manage';

export const DEFAULT_SCAN_EXTENSIONS = ['txt', 'md'];
export const DEFAULT_IGNORE_FILES = [
  CONFIG_FILE_NAME,
  PUB_CONFIG_FILE_NAME,
  LEGACY_PUBLISH_FILE_NAME,
  '.DS_Store'
];
export const DEFAULT_IGNORE_DIRS = [
  '.git',
  '.idea',
  '.vscode',
  'node_modules',
  'uploaded'
];

export const DEFAULT_PUBLISH_COUNT = 3;
