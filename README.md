# dsh-markji-bridge

给 DeepSeek Harness（DSH）的 agent 用的墨墨记忆卡（Markji）插件。它在本地维护一份卡组 / 章节 / 卡片缓存，agent 可以搜索、阅读、新建、修改、归档卡片；所有修改先写入本地队列，再按「先拉取、三方合并、后推送」的顺序同步到云端，冲突单独报告，不影响其他卡片。

16 个 `markji_*` 工具，只用 Node 内置模块实现，无第三方依赖。

## 特性

- **本地缓存**：单个 SQLite 文件 `cache.db`，索引、卡片正文、待推送队列、冲突和同步任务都在一个库里，日常搜索和阅读不请求 API。
- **纯文本搜索**：每张卡另存一列去掉格式标记、图片 / 音频标记、data URI 和 base64 的纯文本，搜索只匹配纯文本，结果干净可读。
- **安全写入**：修改先排队，推送前先拉取远端变更并三方合并，不会用旧数据覆盖云端；冲突按卡片去重，可逐条解决。
- **后台同步**：同步任务立即返回句柄，可查进度；进程崩溃或插件重启后用同一句柄续跑，不重复创建云端对象。
- **归档**：把卡片移入同卡组「归档」章节并在正文插入归档说明，重复调用幂等。
- **多进程安全**：同一台机器的多个 DSH 进程可共用一个缓存目录，写入通过文件锁串行。

## 要求

- DSH 0.2.x 的 Host 插件环境
- Node **>= 22.13**（使用内置 `node:sqlite`，无需启动参数）
- Windows / macOS / Linux

## 安装

从 GitHub 获取源码后，把目录安装为 DSH bundle：

```bash
git clone https://github.com/Oxmyxo/dsh-markji-bridge.git dsh-markji-bridge
```

```text
plugin_manager install_bundle  target=<仓库目录的绝对路径>
```

升级：

```bash
git pull
```

```text
plugin_manager remove_bundle   target=dsh-markji-bridge
plugin_manager install_bundle  target=<仓库目录的绝对路径>
```

只改了 `lib/` 里的代码时，停用再启用插件即可加载新代码：

```text
plugin_manager set_plugin  target=include:dsh-markji-bridge  enabled=false
plugin_manager set_plugin  target=include:dsh-markji-bridge  enabled=true
```

## 配置 token

在 **DSH 主机进程**的环境变量里设置 Markji OpenAPI token（在[墨墨开放平台](https://open.maimemo.com/)获取）：

```powershell
# Windows：设置用户环境变量后重启 DSH
setx MAIMEMO_MARKJI_OPENAPI_TOKEN "<你的 token>"
```

```bash
# macOS / Linux：写入 shell 配置后重开终端
export MAIMEMO_MARKJI_OPENAPI_TOKEN="<你的 token>"
```

token 不要提交到仓库或写进配置文件。插件配置里的 `apiKey` 可以覆盖 token，但会以明文保存在 profile 配置中，一般不需要。

## 快速开始

```text
markji_decks({ refresh: true })
markji_search({ query: "排序", deck: "算法" })
markji_card_get({ card: "<card_id>" })
markji_sync({ mode: "auto" })
```

首次调用会拉取云端数据（卡片多时需要一点时间），之后读操作走本地缓存。状态和进度用 `markji_status` / `markji_sync_status` 查看。

## 工具

| 工具 | 作用 |
| --- | --- |
| `markji_decks` | 列出卡组与文件夹 |
| `markji_chapters` | 列出卡组章节 |
| `markji_cards` | 分页 / 搜索本地卡片 |
| `markji_search` | 按卡组名、章节名、纯文本、更新时间快速找卡 |
| `markji_card_get` | 读单张卡：`content`（富文本）+ `text`（纯文本） |
| `markji_card_create` | 新建卡片 |
| `markji_card_update` | 修改卡片内容 |
| `markji_card_archive` | 归档卡片到「归档」章节 |
| `markji_cards_move` | 移动卡片到其他章节 |
| `markji_chapters_edit` | 新建 / 重命名 / 排序章节 |
| `markji_sync` | 启动后台同步（pull / push / auto，可 resume） |
| `markji_sync_status` | 查看同步任务进度与历史 |
| `markji_failures` | 查看失败卡片、冲突与恢复建议 |
| `markji_status` | 插件与缓存总览 |
| `markji_conflict_resolve` | 解决冲突（keep_local / keep_remote / use_content） |
| `markji_file` | 上传文件到 Markji 或查询文件信息 |

## 配置

默认配置写在 bundle 的 `cordis.patch.yml`，都可用默认值：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否注册工具并启动自动同步 |
| `apiKey` | `''` | 可选的 token 覆盖（建议留空，用环境变量） |
| `baseUrl` | `https://open.maimemo.com/open` | API 地址 |
| `dataDir` | `<home>/.dsh/dsh-markji-bridge` | 缓存目录 |
| `grammarVersion` | `3` | 新卡默认 grammar_version |
| `requestTimeoutMs` | `20000` | 单次请求超时 |
| `maxRetries` | `3` | 网络错误 / 429 / 5xx 重试次数 |
| `pageSize` | `100` | 拉取分页大小 |
| `pullTtlMs` | `600000` | 缓存过期后读操作先增量拉取 |
| `autoSync` | `true` | 空闲时自动推送并拉取 |
| `idleCheckMs` | `30000` | 空闲检查周期 |
| `idleQuietMs` | `120000` | 最近一次工具调用后的静默时间 |
| `autoPullMs` | `900000` | 无待办时的后台拉取周期 |
| `retryBackoffMs` | `300000` | 自动同步失败后的重试间隔 |
| `maxOutputChars` | `20000` | 单个工具结果最大字符数 |

## 同步与恢复

- 读操作在缓存过期时先做增量拉取；写操作只改本地缓存并排队。
- `markji_sync mode=auto`：先拉取远端并三方合并，再推送本地队列；推送前一定会先拉取，避免旧数据覆盖远端修改。
- 冲突不会阻塞其他卡片，处理方式：`keep_local`（保留本地，下次推送覆盖云端）、`keep_remote`（采用云端，丢弃本地改动）、`use_content`（用指定内容替换本地待推送内容）。
- 同步任务会记录进度与结果，最多保留最近 20 条；进程中断后任务标记为 `interrupted`，用 `markji_sync resume=<task_id>` 续跑。
- 失败或冲突用 `markji_failures` 查看，处理完再执行 `markji_sync mode=push`。

## 数据与隐私

- 缓存位于 `<dataDir>/cache.db`（默认 `~/.dsh/dsh-markji-bridge`），只保存在本机，除 Markji API 外不发送到任何地方。
- 插件不把 token 写入缓存或日志；日志中出现的 token 会替换为 `<redacted>`。
- 多个 DSH 进程可共享缓存目录，写入用 `cache.write.lock` 串行；不建议跨机器共享。
- 缓存损坏时会改名保存并重新拉取。

## 已知限制

- Markji OpenAPI 不支持创建 / 删除卡组、删除卡片，这些操作仍需在网页或客户端完成。
- 只支持单个 Markji 账号。
- 冲突需手动解决，未解决时自动推送会暂停。
- `grammarVersion` 是全局默认值，卡片自身版本未知时使用。

## 开发与测试

```bash
node --test "test/*.test.js"       # 单元 / 集成测试
node test/e2e-mock.mjs             # mock 服务端端到端
node test/index-smoke.mjs          # 入口烟测
```

测试需要从本仓库源码运行。主要文件：`index.js`（入口与配置）、`lib/api.js`（HTTP 客户端）、`lib/store.js`（缓存与写锁）、`lib/sync.js`（同步引擎）、`lib/plain-text.js`（纯文本转换）、`lib/tools.js`（工具定义）。

## 许可

MIT，见 [LICENSE](./LICENSE)。