import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const CHAPTER_PATTERN = /第\s*([0-9零〇一二两三四五六七八九十百千万]+)\s*章[\s_：:.-]*(.*)/;

export async function buildChapterFromFile({ filePath, relativePath, rootDir, defaultVolume, index }) {
  const content = await fs.readFile(filePath, 'utf8');
  const lines = content.split(/\r?\n/);
  const rawTitle = path.basename(filePath, path.extname(filePath));
  const firstLine = lines.find((line) => line.trim().length > 0)?.trim() || '';
  const parsedFromName = parseChapterTitle(rawTitle);
  const parsedFromFirstLine = parseChapterTitle(firstLine);
  const chapterNumber = parsedFromName.chapterNumber || parsedFromFirstLine.chapterNumber || '';
  const title = cleanSortPrefix(parsedFromName.title || parsedFromFirstLine.title || fallbackTitle(rawTitle));
  const volume = detectVolume({ rootDir, filePath, defaultVolume });
  const stat = await fs.stat(filePath);

  return {
    index,
    chapterNumber,
    title,
    volume: cleanSortPrefix(volume),
    file: relativePath,
    extension: path.extname(filePath).replace(/^\./, ''),
    bytes: stat.size,
    sha1: crypto.createHash('sha1').update(content).digest('hex')
  };
}

export async function readChapterContent(absFilePath) {
  const content = await fs.readFile(absFilePath, 'utf8');
  const lines = content.split(/\r?\n/);
  if (lines.length > 0 && CHAPTER_PATTERN.test(lines[0].trim())) {
    lines.shift();
  }
  while (lines.length > 0 && lines[0].trim() === '') {
    lines.shift();
  }
  return lines.join('\n');
}

export function parseChapterTitle(value) {
  const match = value.match(CHAPTER_PATTERN);
  if (!match) {
    const leadingNumber = parseLeadingNumber(value);
    return {
      chapterNumber: leadingNumber,
      title: leadingNumber ? cleanSortPrefix(value) : ''
    };
  }
  return {
    chapterNumber: match[1],
    title: cleanSortPrefix(match[2]?.trim() || '')
  };
}

export function chapterSortKey(chapter) {
  const numeric = chapterNumberToNumber(chapter.chapterNumber);
  return {
    hasNumber: Number.isFinite(numeric),
    number: numeric,
    file: chapter.file
  };
}

export function compareChapters(left, right) {
  const a = chapterSortKey(left);
  const b = chapterSortKey(right);
  if (a.hasNumber && b.hasNumber && a.number !== b.number) {
    return a.number - b.number;
  }
  if (a.hasNumber !== b.hasNumber) {
    return a.hasNumber ? -1 : 1;
  }
  return a.file.localeCompare(b.file, 'zh-Hans-CN', { numeric: true });
}

function fallbackTitle(rawTitle) {
  return cleanSortPrefix(rawTitle.replace(/^\s*\d+[\s_.-]*/, '').trim() || rawTitle);
}

function parseLeadingNumber(value) {
  const match = value.match(/^\s*(\d+)/);
  return match ? match[1] : '';
}

function detectVolume({ rootDir, filePath, defaultVolume }) {
  const parent = path.dirname(path.relative(rootDir, filePath));
  if (!parent || parent === '.') {
    return defaultVolume;
  }
  return parent.split(path.sep)[0] || defaultVolume;
}

export function cleanSortPrefix(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }
  const cleaned = text.replace(/^\s*\d{1,4}\s*[-_.,，、：:\s]?\s*/, '').trim();
  return cleaned || text;
}

function chapterNumberToNumber(value) {
  if (!value) {
    return Number.NaN;
  }
  if (/^\d+$/.test(String(value))) {
    return Number(value);
  }
  return chineseNumberToInteger(String(value));
}

function chineseNumberToInteger(value) {
  const digits = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9
  };
  const units = {
    十: 10,
    百: 100,
    千: 1000,
    万: 10000
  };

  let result = 0;
  let section = 0;
  let number = 0;
  for (const char of value) {
    if (char in digits) {
      number = digits[char];
      continue;
    }
    if (char in units) {
      const unit = units[char];
      if (unit === 10000) {
        section = (section + number) * unit;
        result += section;
        section = 0;
      } else {
        section += (number || 1) * unit;
      }
      number = 0;
    }
  }
  return result + section + number;
}
