import path from 'node:path';
import { Command } from 'commander';
import {
  CONFIG_FILE_NAME,
  DEFAULT_PUBLISH_COUNT,
  PUBLISH_FILE_NAME
} from './constants.js';
import { login, logout, verifyStoredLoginState } from './auth.js';
import {
  createDefaultProjectConfig,
  createDefaultPubConfig,
  loadProjectConfig,
  normalizeExtensions,
  toPubConfig,
  toUserProjectConfig,
  writeYamlFile
} from './config.js';
import { scanProject } from './scanner.js';
import { pathExists } from './io.js';
import { publishChapters, saveDrafts, testPublishFlow } from './publisher.js';

export function runCli(argv) {
  const program = new Command();
  program
    .name('fanqie')
    .description('番茄小说 Node.js 全自动发文 CLI')
    .version('0.1.0');

  program
    .command('login')
    .description('扫码登录番茄作家平台；若当前已登录则不会重复登录')
    .option('-f, --force', '忽略已有凭证并重新登录')
    .action(async (options) => {
      await login({ force: Boolean(options.force) });
    });

  program
    .command('logout')
    .description('退出番茄登录并删除本地登录凭证')
    .action(async () => {
      await logout();
    });

  program
    .command('status')
    .description('检测番茄登录状态')
    .action(async () => {
      const result = await verifyStoredLoginState();
      console.log(result.loggedIn ? '已登录' : '未登录');
      console.log(result.reason);
    });

  program
    .command('init')
    .description(`在当前目录生成 ${CONFIG_FILE_NAME}，并自动扫描章节`)
    .option('-n, --name <name>', '小说名，默认使用当前目录名')
    .option('-s, --summary <summary>', '小说摘要')
    .option('-v, --volume <volume>', '当前默认分卷', '第1卷')
    .option('-e, --extensions <extensions>', '扫描扩展名，逗号分隔', 'txt,md')
    .option('-f, --force', `覆盖已有 ${CONFIG_FILE_NAME}`)
    .action(async (options) => {
      const rootDir = process.cwd();
      const configPath = path.join(rootDir, CONFIG_FILE_NAME);
      if ((await pathExists(configPath)) && !options.force) {
        throw new Error(`${CONFIG_FILE_NAME} 已存在。如需重建，请使用 \`fanqie init --force\`。`);
      }

      const userConfig = createDefaultProjectConfig({
        rootDir,
        novelName: options.name,
        summary: options.summary,
        extensions: normalizeExtensions(options.extensions)
      });
      const config = {
        ...userConfig,
        ...createDefaultPubConfig({
          currentVolume: options.volume
        })
      };
      const scanned = await scanProject({ rootDir, config });
      await writeYamlFile(configPath, toUserProjectConfig(scanned, rootDir));
      await writeYamlFile(path.join(rootDir, PUBLISH_FILE_NAME), toPubConfig(scanned));

      console.log(`已生成配置：${configPath}`);
      console.log(`已生成发布公共配置：${path.join(rootDir, PUBLISH_FILE_NAME)}`);
      console.log(`小说名：${scanned.novel.name}`);
      console.log(`扫描章节数：${scanned.chapters.count}`);
      console.log(`默认每次发布章节数：${scanned.publish.defaultCount}`);
    });

  program
    .command('scan')
    .description(`按 ${CONFIG_FILE_NAME} 的扫描规则更新小说目录和章节信息`)
    .action(async () => {
      const { configPath, pubConfigPath, rootDir, config } = await loadProjectConfig(process.cwd());
      const scanned = await scanProject({ rootDir, config });
      await writeYamlFile(configPath, toUserProjectConfig(scanned, rootDir));
      await writeYamlFile(pubConfigPath, toPubConfig(scanned));
      console.log(`已更新配置：${configPath}`);
      console.log(`已更新发布公共配置：${pubConfigPath}`);
      console.log(`扫描章节数：${scanned.chapters.count}`);
    });

  program
    .command('push')
    .description(`发布章节，并写入 ${PUBLISH_FILE_NAME} 以支持断点续传`)
    .option('-c, --count <count>', `本次发布章节数量，默认读取配置；初始默认 ${DEFAULT_PUBLISH_COUNT}`, parsePositiveInteger)
    .option('--dry-run', '只生成和展示发布计划，不启动浏览器')
    .option('-f, --force', '包含已发布章节，用于修复线上异常章节')
    .action(async (options) => {
      const { rootDir, config } = await loadProjectConfig(process.cwd());
      await publishChapters({
        rootDir,
        config,
        count: options.count,
        dryRun: Boolean(options.dryRun),
        force: Boolean(options.force)
      });
    });

  program
    .command('save')
    .description(`保存章节为草稿，并写入 ${PUBLISH_FILE_NAME} 以记录草稿状态`)
    .option('-c, --count <count>', `本次保存草稿章节数量，默认读取配置；初始默认 ${DEFAULT_PUBLISH_COUNT}`, parsePositiveInteger)
    .option('--dry-run', '只生成和展示保存草稿计划，不启动浏览器')
    .action(async (options) => {
      const { rootDir, config } = await loadProjectConfig(process.cwd());
      await saveDrafts({
        rootDir,
        config,
        count: options.count,
        dryRun: Boolean(options.dryRun)
      });
    });

  program
    .command('test')
    .description('模拟发布 1 章，停在最终“确认发布”面板，不点击确认发布')
    .action(async () => {
      const { rootDir, config } = await loadProjectConfig(process.cwd());
      await testPublishFlow({
        rootDir,
        config
      });
    });

  program.exitOverride();
  program.parseAsync(argv).catch((error) => {
    if (error.code === 'commander.helpDisplayed' || error.code === 'commander.version') {
      return;
    }
    console.error(error.message);
    process.exitCode = 1;
  });
}

function parsePositiveInteger(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error('发布章节数量必须是大于 0 的整数。');
  }
  return parsed;
}
