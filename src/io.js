import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';

export async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function promptEnter(message) {
  const rl = readline.createInterface({ input, output });
  try {
    await rl.question(message);
  } finally {
    rl.close();
  }
}

export async function promptChoice({ title, message, options }) {
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error('控制台选择项不能为空。');
  }

  console.log('');
  console.log(title);
  if (message) {
    console.log(message);
  }
  options.forEach((option, index) => {
    console.log(`${index + 1}. ${option.label}`);
  });

  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question('请输入序号并回车：');
      const selectedIndex = Number.parseInt(String(answer).trim(), 10) - 1;
      if (Number.isInteger(selectedIndex) && options[selectedIndex]) {
        return options[selectedIndex].value;
      }
      console.log(`请输入 1-${options.length} 之间的序号。`);
    }
  } finally {
    rl.close();
  }
}

export function toPosixPath(filePath) {
  return filePath.split(path.sep).join('/');
}

export function nowIso() {
  return new Date().toISOString();
}
