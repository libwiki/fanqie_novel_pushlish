# 番茄小说 Node.js 全自动发文 CLI

* 参考自Python项目： https://github.com/hchcx/fanqie_auto_publish

这是一个参考 `hchcx/fanqie_auto_publish` 思路重写的 Node.js CLI 工具。它使用 Playwright 驱动真实浏览器完成番茄作家后台登录、章节管理、新建章节、填写标题正文、处理常见弹窗和确认发布。

## 安装

```bash
npm install
npm link
```

如果 Playwright 没有自动下载浏览器内核，可手动执行：

```bash
npx playwright install chromium
```

## 命令

```bash
fanqie login
fanqie logout
fanqie status
fanqie init
fanqie scan
fanqie test
fanqie save
fanqie push
```

### `fanqie login`

打开浏览器进入番茄作家后台。完成扫码或账号登录后，回到终端按回车保存登录状态。

登录态保存到：

```text
~/.fanqie-novel-publisher/state.json
```

如果当前登录态仍有效，`login` 会提示“当前已登录”，不会重复打开登录流程。需要换号时先执行：

```bash
fanqie logout
```

### `fanqie init`

在当前目录生成项目配置文件 `fanqie.yaml` 和 CLI 自动维护文件 `fanqie_pub.yaml`，并自动扫描章节。

```bash
fanqie init --name 我的小说 --summary "一句话简介" --volume 第1卷
```

默认扫描 `.txt` 和 `.md` 文件。配置文件中可以调整扫描扩展名、过滤文件名和过滤目录，过滤规则支持通配符：

```yaml
scan:
  root: .
  extensions:
    - txt
    - md
  ignoreFiles:
    - fanqie.yaml
    - fanqie_pub.yaml
    - README.md
    - "*大纲*"
  ignoreDirs:
    - .git
    - node_modules
    - 草稿*
```

如果扫描目录中存在 `.gitignore`，`fanqie scan` 会同时遵守 `.gitignore` 中的忽略规则。

`fanqie.yaml` 只记录用户可编辑的小说名、摘要和扫描规则。`fanqie_pub.yaml` 由 CLI 自动维护，记录当前默认分卷、默认发布数量、章节数量、章节名、章节号、所属分卷、文件路径、文件大小、sha1 和发布状态。

`fanqie.yaml` 还可以配置 `push` 和 `save` 是否使用无头浏览器，默认关闭：

```yaml
browser:
  headless: false
```

设置为 `true` 后，`fanqie push` 和 `fanqie save` 会使用无头浏览器运行；需要选择小说、处理重复章节、确认异常章节或选择分卷时，会直接在控制台打印候选项并读取序号。`login`、`status`、`scan`、`test` 等其它指令仍走原有逻辑。

### `fanqie scan`

按 `fanqie.yaml` 中的扫描规则重新扫描目录，并更新章节目录。

```bash
fanqie scan
```

### `fanqie push`

发布章节。该命令会先检测登录状态，没有登录凭证会提示先执行 `fanqie login`。

```bash
fanqie push
fanqie push --count 5
fanqie push --force --count 1
```

默认发布章节数写在 `fanqie_pub.yaml`：

```yaml
publish:
  defaultCount: 3
```

发布状态也写入 `fanqie_pub.yaml`，用于断点续传。已发布且 sha1 未变化的章节会被跳过；如果源文件内容变化，下一次会重新进入待发布队列。

如果线上章节出现异常，例如字数为 0，但本地已经记录为 `published`，可以使用 `fanqie push --force` 把已发布章节也纳入队列。进入后台检测到重复章节号时，会弹框让你选择覆盖、跳过或取消。

### 发布前预览

```bash
fanqie push --dry-run
```

当前 `push` 命令仍会执行登录检测；未登录时不会生成发布计划。

### `fanqie save`

保存章节为草稿。它会和正式发布一样进入后台、打开章节编辑器并填写章节号、标题和正文，但最后点击“存草稿”，不会点击“下一步”进入发布确认面板。

```bash
fanqie save
fanqie save --count 5
fanqie save --dry-run
```

已保存草稿且 sha1 未变化的章节会在下一次 `save` 中跳过；这些章节仍可由后续 `fanqie push` 继续发布。

### `fanqie test`

模拟发布流程，只处理 1 章。它会和正式发布一样打开后台、进入章节管理、新建或接管草稿、填写章节号、标题和正文，并点击“下一步”进入最终发布面板。

该命令不会点击“确认发布”。当页面出现“确认发布”按钮或最终确认弹框时，CLI 会暂停等待，你可以在浏览器里手动点击“取消”，然后回到终端按回车结束测试。

```bash
fanqie test
```

## 章节命名建议

建议每章一个文件，并在文件名或正文第一行包含章节号和标题：

```text
001 第1章 开端.txt
002 第2章 风起.md
```

正文第一行如果是 `第X章 标题`，发布时会自动从正文中移除这一行，避免标题重复。

## 注意

番茄作家后台页面结构可能变化。若平台调整按钮文案、弹窗或编辑器结构，需要同步更新 `src/publisher.js` 中的选择器和兜底逻辑。

多部小说账号下，CLI 使用 `fanqie.yaml` 中的 `novel.name` 匹配后台作品卡片。作品名必须与后台显示名称一致；如果找不到匹配作品，命令会直接中止，不会退化为点击第一本小说。

重复防护依赖两层机制：本地 `fanqie_pub.yaml` 用文件路径和 sha1 记录章节状态；进入后台章节管理后，还会按章节号查找已有行，优先接管已有草稿或章节记录，避免重复新建同一章。

如果找不到 `fanqie.yaml` 中指定的小说，浏览器页面会弹出选择框，列出当前页面提取到的最多 5 个候选作品，可选择目标作品或取消本次任务。

如果启用了 `browser.headless: true`，上述选择会改为在控制台显示候选项并输入序号。

同一次 `push` 或 `save` 命令内，作品只选择一次。后续章节会复用同一个作品章节管理页，不会每章都回到作品列表重复选择。

同一次 `push` 或 `save` 命令内只处理同一卷的连续章节。如果本轮配置要发 5 章，但当前卷只剩 2 章，本轮只处理这 2 章，下一轮再处理下一卷。

如果本地章节所属分卷和番茄后台分卷对不上，浏览器页面会弹出选择框，让你选择本轮要发布到的分卷。选择后本轮所有章节都会使用这个分卷，后续章节会静默应用同一个选择，不再重复弹框。

分卷弹框只显示当前小说真实存在的分卷，并在末尾提供一个蓝色“创建分卷：目标分卷名”选项。选择创建后，CLI 会点击番茄的“新建分卷”，填写目标分卷名并确认。

每章发布或保存草稿完成后，CLI 会延迟关闭上一章的编辑标签页，并回到同一个章节管理页继续处理下一章；最后一章编辑标签页会保留，页面切回章节管理/草稿箱，给番茄前端留出更多时间完成字数统计和保存。

如果后台已存在同章节号记录，浏览器页面会弹出选择框，可选择覆盖/继续编辑、排除本章继续后续任务，或取消本次任务。

如果章节号缺失、标题缺失、正文文件为空、队列内章节号重复、章节号倒退或不连续，浏览器页面会弹出确认框，可选择继续处理本章或取消本次任务。

无头浏览器模式下，重复章节、章节警告和目标分卷未匹配等交互都会在控制台完成；流程结束后会直接关闭浏览器，不再等待用户检查浏览器窗口。

卷名和章节名会自动清理前置排序数字，兼容 `01-卷名`、`01 卷名`、`01、卷名`、`01卷名` 等命名；清理后的名称用于番茄后台分卷和章节标题。
