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

## 工具参数与返回值

`?` 表示可选参数。id 都是 Markji OpenAPI id；尚未推送的新对象使用 `local_*` id。工具结果统一为 JSON，超过 `maxOutputChars` 会截断。

| 工具 | 参数 | 返回（主要字段） |
| --- | --- | --- |
| `markji_decks` | `refresh?` `folder_id?` | `{folders, decks, total, cache}` |
| `markji_chapters` | `deck?` `refresh?` | 指定 `deck`：`{deck_id, deck_name, chapters, cache}`；不指定：`{decks, cache}` |
| `markji_cards` | `deck?` `chapter?` `query?` `limit?` `offset?` | `{total, offset, limit, has_more, cards, cache}` |
| `markji_search` | `query?` `deck?` `deck_name?` `chapter?` `chapter_name?` `updated_after?` `updated_before?` `limit?` `offset?` `refresh?` | `{total, offset, limit, has_more, filters, cards, cache}` |
| `markji_card_get` | `card` `deck?` | `{card}` |
| `markji_card_create` | `deck` `chapter` `content` `order?` `grammar_version?` | `{ok, card_id, deck_id, chapter_id, status, changed, pending, message}` |
| `markji_card_update` | `card` `content` `grammar_version?` | `{ok, card_id, status, changed, pending, message}` |
| `markji_card_archive` | `cards`（非空数组） | `{ok, archived, content_updated, already_archived, moved, chapters, status, pending, message}` |
| `markji_cards_move` | `cards` `to_chapter` `deck?` `order?` | `{ok, moved, to_chapter_id, status, pending, message}` |
| `markji_chapters_edit` | `action: create/rename/sort`；create：`deck` `name` `order?`；rename：`chapter` `name` `deck?`；sort：`deck` `chapter_ids` | `{ok, action, chapter_id?, deck_id?, chapters?, status, pending, message}` |
| `markji_sync` | `mode?: auto/pull/push` `full?` `resume?` | `{task, already_running?}` |
| `markji_sync_status` | `task_id?` | `{active, tasks}` |
| `markji_failures` | `card?` `deck?` `limit?` | `{ok, summary, conflicts, failed_cards, last_task_errors, recovery, truncated}` |
| `markji_status` | 无 | `{version, data_dir, cache_file, configured, base_url, cache, pending, conflicts, last_sync, last_error, active_task, tasks, auto_sync}` |
| `markji_conflict_resolve` | `id` `strategy: keep_local/keep_remote/use_content` `content?` | `{ok, id, entity, strategy, state, changed}` |
| `markji_file` | `action: upload/query`；upload：`path` `deck?`；query：`ids` `expires?` | upload：`{file}`；query：`{files}` |

### 返回结构

```text
CacheInfo = {
  pulled_at?, last_full_pull_at?, stale: boolean,
  error: string|null, save_error?: string|null,
}

DeckView = {
  id, name, description, card_count, chapter_count,
  updated_time, is_private, source, status, missing,
}

ChapterView = {
  id, name, revision, order, card_count,
  pending: null | object, updated_time, local, missing,
}

CardSummary = {
  id, deck_id, deck_name, chapter_id, chapter_name,
  status: "synced" | "dirty" | "new" | "conflict",
  revision, snippet, updated_time,
}

CardView = {
  id, deck_id, chapter_id, chapter_name,
  content: string, text: string, grammar_version: number,
  status, local: boolean,
  cloud: null | { revision, updated_time },
  pending: null | { content, grammar_version },
  conflict: null | ConflictView,
  last_error: null | { code, message },
  created_time, updated_time,
}

ConflictView = {
  id, kind, entity, deck_id, chapter_id, card_id, op,
  local, remote, state, detected_at,
  deck_name, chapter_name, card_snippet,
  recovery: { tool, arguments, strategies, hint },
}

SyncTask = {
  task_id, status: "running" | "completed" | "failed" | "interrupted",
  mode: "auto" | "pull" | "push", full: boolean,
  started_at, updated_at, finished_at, stage, resume_count,
  progress: {
    message, decks_total, decks_done, decks_seen, chapters, cards,
    cards_deleted, adopted_cards, adopted_chapters, conflicts_created,
    chapters_created, chapters_renamed, chapters_sorted,
    cards_created, cards_updated, cards_moved, errors,
  },
  error: null | { code, message },
  report: null | SyncReport,
}

SyncReport = {
  ok, mode, started_at, finished_at, duration_ms,
  pull: {
    decks, chapters, cards, cards_deleted,
    adopted_cards, adopted_chapters, conflicts,
  },
  push: {
    chapters_created, chapters_renamed, chapters_sorted,
    cards_created, cards_updated, cards_moved, conflicts, errors,
  },
  conflicts: [ConflictView], errors: [{ op, id, code, message }],
  errors_total, cache: CacheInfo,
}

Status = {
  version, data_dir, cache_file, configured, base_url,
  cache: {
    decks, chapters, cards, bytes, pulled_at, last_full_pull_at,
    pushed_at, stale, error, save_error,
  },
  pending: {
    cards_new, cards_dirty, chapters_new, chapters_rename,
    moves, sorts, conflicts,
  },
  conflicts: [ConflictView], last_sync: SyncReport|null,
  last_error: null | { code, message },
  active_task: SyncTask|null, tasks: [SyncTask],
  auto_sync: {
    enabled, timer, running, last_activity_at,
    idle_quiet_ms, pull_ttl_ms,
  },
}

Failures = {
  ok, summary: { conflicts, failed_cards, last_task_errors, last_error },
  conflicts: [ConflictView],
  failed_cards: [{
    id, deck_id, deck_name, chapter_id, chapter_name,
    status, local, pending, snippet,
    error: { code, message },
    recovery: { tool, arguments, strategies, hint },
  }],
  last_task_errors: [{ task_id, op, id, code, message }],
  recovery: { conflicts, failed_cards, after_resolution },
  truncated: boolean,
}
```

`markji_card_archive` 的 `chapters` 是 `[{ deck_id, chapter_id, chapter_name, local }]`。`markji_file` 的 `file` 由 Markji 返回，常见字段为 `id`、`url`、`mime`、`size`、`info`、`expire_time`。

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

## 性能与行为

- 读操作优先读本地缓存；缓存超过 `pullTtlMs`（默认 10 分钟）或显式 `refresh: true` 时先做增量拉取。
- 1.0.1 起，未知 id 触发的兜底刷新只拉取“云端标记为变化”的卡组，不再全量拉取所有卡组。实测 5265 张卡 / 82 章节的账号：未知章节重命名约 0.8 秒返回 `unknown_chapter`，未知卡片约 0.3 秒；旧版全量拉取约 12.5 秒。
- 确实需要全量刷新时显式运行 `markji_sync({ mode: "pull", full: true })`；全量拉取是后台任务，先返回 `task`，再用 `markji_sync_status` 查进度。
- 写操作只改本地缓存并立即返回，网络请求发生在同步任务或自动同步里。
- 自动同步：最近一次工具调用后静默 `idleQuietMs`（默认 2 分钟）触发；无待办时每 `autoPullMs`（默认 15 分钟）拉取；失败后按 `retryBackoffMs`（默认 5 分钟）重试。
- 有未解决冲突时自动推送暂停，但拉取继续。
- 请求受滑动窗口限流（默认每 10 秒 18 次、每分钟 36 次、每 5 小时 7800 次），并发同步会自动排队。
- 单张卡内容上限 100000 字符；`markji_cards` 的 `limit` 上限 200，`markji_search` 上限 100。

## 错误码与故障排查

工具错误一般形如 `markji: <code>: <message> (hint: ...)`；参数格式错误可能是普通的 `markji_xxx: "field" ...` 消息（没有 code）。常见 code：

| code | 含义与处理 |
| --- | --- |
| `not_configured` | 没有可用的 token。设置 `MAIMEMO_MARKJI_OPENAPI_TOKEN` 后完全退出并重启 DSH，让主机进程读到新环境变量。 |
| `unknown_deck` / `unknown_chapter` / `unknown_card` / `unknown_folder` | 本地缓存里没有这个 id。兜底刷新已尝试过；如果对象是在其他设备新建的，执行 `markji_sync({ mode: "pull", full: true })` 后再试。 |
| `invalid_argument` | 参数缺失、类型不对、时间格式不对、`chapter_ids` 没有列全、内容为空或超过 100000 字符等。按消息修正参数。 |
| `invalid_content` | 卡片内容不合法（例如规范化后为空）。 |
| `conflict_open` | 这张卡有未解决冲突。先用 `markji_conflict_resolve` 处理。 |
| `unknown_conflict` | 冲突 id 不存在或已解决。用 `markji_failures` 重新获取当前冲突列表。 |
| `unknown_task` / `task_not_resumable` | `resume` 的任务 id 不存在，或该任务不是 `interrupted` / 已结束。用 `markji_sync_status` 查任务状态。 |
| `deck_mismatch` | 目标章节或卡片不属于指定卡组。检查 id 与 `deck` 参数是否匹配。 |
| `cache_busy` | 另一个 DSH 进程正持有 `cache.write.lock`。等它结束再重试；不要手工删除活动进程的锁。 |
| `engine_unavailable` | 插件引擎没有加载完整。停用再启用插件，或重启 DSH。 |
| `conflict_resolve_failed` | 解决冲突时写入失败，详情见消息；通常可重试或改用 `keep_remote`。 |
| `bad_response` | Markji 返回了无法解析的数据。重试；持续出现时检查 `baseUrl` 和网络。 |
| `common_*` | Markji 服务端错误码（如 `common_unauthorized`、`common_invalid_res_id`、`common_revision_mismatch`），以服务端返回的 code 和消息为准。 |
| `ENOENT` | `markji_file` 上传的本地路径不存在。 |

常见问题：

- **`markji_status` 里 `configured: false`**：DSH 主机进程没有读到 token。Windows 用 `setx` 后必须重启 DSH；WSL / Linux 要在启动 DSH 的同一 shell 里 `export`，再重启 DSH。
- **401 / 403**：token 无效、过期或没有 OpenAPI 权限；到开放平台重新生成。不要把 token 写进 `cordis.patch.yml` 或提交到仓库。
- **首次调用很慢**：首次要拉取全部卡组、章节和卡片；几千张卡通常需要几十秒到几分钟，属正常。用后台任务和 `markji_sync_status` 观察，不要重复发起。
- **刚在手机 / 网页新建的卡本地找不到**：兜底刷新只拉变化的卡组，若卡组 `updated_time` 没变，执行 `markji_sync({ mode: "pull", full: true })`。
- **自动同步没有推送**：先看 `markji_failures` 是否有开放冲突；有冲突时推送会暂停。解决后执行 `markji_sync({ mode: "push" })`。
- **`cache_busy` 持续出现**：确认是否有另一个 DSH 进程在使用同一 `dataDir`；关闭多余进程。进程崩溃留下的锁会按持有者 pid / 主机名判断后回收。
- **缓存损坏**：插件会把旧库改名备份并重建，然后重新拉取；看 DSH 日志和 `markji_status.last_error` 确认。
- **WSL 中使用**：DSH 本身要运行在该 WSL 发行版的 Linux 环境里；token 在启动 DSH 的 shell 中 `export`。SQLite 缓存建议放在 Linux 文件系统（如 `~/.dsh/...`），不要放在 `/mnt/c` 下，避免文件锁和性能问题。

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

## 平台验证

| 环境 | 结果 |
| --- | --- |
| Windows + Node 24.21.0 | 真实账号实测：同步、文件 / 图片上传、归档、远端删除冲突、章节删除冲突、崩溃续跑；单元 78/78，独立验证 138/138（内部测试集），E2E 13/13，冒烟 16 个工具。 |
| WSL2 Ubuntu 26.04（Linux 6.18，Node v22.22.1） | 仓库复制到 Linux 文件系统（`/tmp`）后运行：单元 78/78，独立验证 138/138（内部测试集），E2E 13/13，入口冒烟 16 个工具。 |
| macOS | 未实机测试；代码只用 Node 内置模块，理论上可用。 |

WSL 验证是在 Linux 环境里直接跑仓库的测试和入口烟测，不是在 WSL 里另装一套 DSH。要在 WSL 里实际使用，DSH 本身也应运行在该发行版中。

## 开发与测试

需要 Node >= 22.13，从仓库源码运行：

```bash
node --test "test/*.test.js"   # 单元 / 集成测试（78 项）
node test/e2e-mock.mjs         # mock 服务端端到端（13 项）
node test/index-smoke.mjs      # 入口烟测（16 个工具）
```

另有一套不随仓库发布的内部独立验证集（138 项），用于发布前交叉检查；公开仓库只包含上面列出的测试。

测试需要从本仓库源码运行。主要文件：`index.js`（入口与配置）、`lib/api.js`（HTTP 客户端）、`lib/store.js`（缓存与写锁）、`lib/sync.js`（同步引擎）、`lib/plain-text.js`（纯文本转换）、`lib/tools.js`（工具定义）。

## 许可

MIT，见 [LICENSE](./LICENSE)。