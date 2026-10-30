**中文** | [English](https://github.com/Oxmyxo/dsh-markji-bridge/blob/main/README.en.md)

# dsh-markji-bridge

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/oxmyxo/dsh-markji-bridge) [![dsh.so install · dsh 0.2.1-rc.2](https://www.dsh.so/badge/install/dsh-markji-bridge@0.2.1-rc.2.svg)](https://www.dsh.so/artifact/dsh-markji-bridge/) [![dsh.so risk](https://www.dsh.so/badge/dsh-markji-bridge.svg)](https://www.dsh.so/artifact/dsh-markji-bridge/)

给 DeepSeek Harness（DSH）的 agent 用的墨墨记忆卡（Markji）插件。它在本地维护一份卡组 / 章节 / 卡片缓存，agent 可以搜索、阅读、新建、修改、归档卡片；所有修改先写入本地队列，再按「先拉取、三方合并、后推送」的顺序同步到云端，冲突单独报告，不影响其他卡片。

只注册 4 个按 `action` 组织的 `markji_*` 工具，只用 Node 内置模块实现，无第三方依赖：`markji_decks`（卡组 / 章节，含章节详情、新建、重命名、排序）、`markji_cards`（列表过滤、读写、语法、归档、移动）、`markji_sync`（同步、等待、进度、状态、失败与冲突）、`markji_file`（文件）。写卡前用 `markji_cards({ action: "syntax_help" })` 查语法；`create` / `update` 会在入队前自动校验语法和媒体引用，无需额外调用校验。批量读写用同一工具的 `new_cards` / `updates`。

## 特性

- **本地缓存**：单个 SQLite 文件 `cache.db`，索引、卡片正文、待推送队列、冲突和同步任务都在一个库里，日常搜索和阅读不请求 API。
- **统一列表过滤（JSON 条件树）**：`markji_cards` 的 `list`、`markji_decks` 的 `list` / `chapter_list` 使用同一个 `filter` 参数（字段集各自独立），没有单独的 `search` action，所有过滤都由 `filter` 完成：
  - `filter`：JSON 条件树，不是 JS。条件为 `{ field, op, value, case_sensitive?, flags? }`，组合为 `{ all: [...] }` / `{ any: [...] }` / `{ not: {...} }`；op 支持 `eq`、`ne`、`contains`、`starts_with`、`ends_with`、`regex`、`in`、`not_in`、`gt`、`gte`、`lt`、`lte`、`exists`。正则用 `flags` 设置 `imsu`（默认 `i`），`case_sensitive: true` 也可关闭字符串匹配和正则的默认大小写不敏感。`filter` 省略或传 `{}` 表示不过滤。
  - `scope`：卡片支持 `all` / `deck` / `chapter`，章节支持 `all` / `deck`，卡组支持 `all` / `folder`；不传时由 `deck` / `chapter` / `folder_id` 推断，显式冲突会报错。
  - 每个 list 的字段集独立：卡组只认卡组字段（`name` / `description` / `id`、更新时间、计数等），章节只认章节字段（没有 `description`，也不支持 `deck_name`，按父卡组筛选用 `scope=deck`），卡片保留更宽的条件（`text` / `content` / `cloud` / `status` 等）。不属于该 list 的字段或操作会报 `invalid_argument`，不会跨资源匹配。
- **纯文本匹配**：每张卡另存一列去掉格式标记、图片 / 音频标记、data URI 和 base64 的纯文本，`text` 字段只含纯文本，结果干净可读；`content` 保留原始富文本，便于正则在正文上匹配。
- **安全写入**：修改先排队，推送前先拉取远端变更并三方合并，不会用过期的本地缓存覆盖云端；冲突按卡片去重，可逐条解决。
- **插件页与加密凭证**：插件详情页可填 Markji API Key，并选择 `cache.db` 目录。Key 只以 AES-256-GCM 密文写入 `cache.db` 的 `secrets` 表；数据密钥由 DSH 凭据服务或仅当前用户可读的 `secret.key` 保存，配置文件和源码里不会出现明文 token。
- **自动写前校验与媒体预检**：`markji_cards` 的 `action=syntax_help` 可按格式或全部查询原始 Markji 语法；`create` / `update` 在入队前自动校验每条正文，并默认批量查询 `Pic` / `Audio` 引用的文件 id（`checkMediaOnWrite: false` 可跳过媒体查询）。语法错误、文件缺失或查询失败会让该条直接失败且不产生待推送卡，批量中的其他项继续。`markji_sync` 推送前仍保留同一套预检作为最后一道闸。
- **后台同步**：同步任务立即返回句柄，可查进度；进程崩溃或插件重启后用同一句柄续跑，不重复创建云端对象。DSH 加载了 `dsh-tool-jobs` 时，`markji_sync({ action: "start" })` 还会把任务登记为当前会话拥有的 DSH 后台任务，返回 `job_id`；任务出现在「正在运行的后台任务」中，`job_output` 会随同步进度实时追加输出，并显示当前阶段与 `done/total`（拉取为 `2/5 decks`，推送为 `cards_create 12/50`），结束后由 DSH 发送完成通知；也可以 `markji_sync({ action: "wait", task_id })` 阻塞到该任务结束（可选 `timeout_ms`，超时返回 `task.timed_out: true`）。终止后台任务会在下一个检查点取消同步，任务变为 `interrupted`，仍可 `resume`。
- **归档与章节操作**：`markji_cards({ action: "archive" })` 把卡片移入同卡组「归档」章节并在正文插入归档说明，重复调用幂等；`markji_decks` 支持章节详情、新建、重命名和排序（provider 不提供章节删除接口）。
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

## 配置 API Key 与缓存位置

在 DSH 的**插件 → 墨墨记忆卡桥接**详情页里填写 Markji OpenAPI Key（在[墨墨开放平台](https://open.maimemo.com/)获取），点「保存并测试」：插件会先调用一次只读接口校验，通过后用 AES-256-GCM 加密写入 `cache.db` 的 `secrets` 表，页面只显示 `hasKey` 和尾 4 位，不回显明文。

同一个插件详情页可以选择 `cache.db` 所在目录：修改时会把现有 `cache.db`（以及 `secret.key`，如果使用文件 DEK）复制到新目录，原目录保留以便回退；需要重启 DSH 生效。

> 可选引导配置：`cordis.patch.yml` 的 `apiKey`、环境变量 `MAIMEMO_MARKJI_OPENAPI_TOKEN` / `MAIMEMO_OPENAPI_TOKEN` 可作为首次启动的输入；插件启动时会把它们加密写入 `cache.db` 并从进程环境清除。推荐直接在插件详情页配置。不要提交 token。

## 快速开始

```text
markji_decks({ action: "list", refresh: true })
markji_decks({ action: "get", deck: "<deck_id>" })
markji_decks({ action: "chapter_get", chapter: "<chapter_id>", with_cards: true })
markji_cards({ action: "list", filter: { field: "text", op: "contains", value: "排序" }, deck_name: "算法" })
markji_decks({ action: "list", filter: { field: "name", op: "contains", value: "算法" } })
markji_decks({ action: "chapter_list", filter: { field: "name", op: "regex", value: "^SPI\s+时钟" } })
markji_cards({ action: "list", scope: "deck", deck: "<deck_id>", filter: { all: [{ field: "status", op: "eq", value: "dirty" }, { field: "updated_time", op: "gte", value: "2026-10-01" }] } })
markji_cards({ action: "get", card: "<card_id>" })
markji_cards({ action: "get", cards: ["<card_id_1>", "<card_id_2>"] })
markji_cards({ action: "syntax_help" })
markji_cards({ action: "syntax_help", format: "picture" })
markji_cards({ action: "create", deck: "<deck>", chapter: "<chapter>", new_cards: [{ content: "<Markji 富文本>" }] })
markji_sync({ action: "start", mode: "auto" })
markji_sync({ action: "wait", task_id: "<task_id>", timeout_ms: 300000 })
```

首次调用会拉取云端数据（卡片多时需要一点时间），之后读操作走本地缓存。状态和进度用 `markji_sync({ action: "state" })` / `markji_sync({ action: "progress" })` 查看；传 `task_id` 时只返回该任务的 `{ task }`，不传时返回 `{ active, tasks }`。`action: "wait"` 会阻塞到指定任务结束，`timeout_ms` 省略时最多等 30 分钟（与工具超时一致）；超时后返回仍在运行的 `task`，并带 `timed_out: true`。若 DSH 加载了 `dsh-tool-jobs`，`start` 还会返回 `job_id`：在 DSH 的后台任务列表里能直接看到进度，`job_output` 的输出也会按进度实时追加，任务结束后会自动收到完成通知，也可以用 `job_output` 读取最终结果。

## 批量操作

需要一次处理多张卡时用 `markji_cards` 的这些 action：

```text
markji_cards({ action: "get", cards: ["<id1>", "<id2>"] })
markji_cards({ action: "create", deck: "<deck>", chapter: "<chapter>", new_cards: [
  { content: "<正文1>" },
  { content: "<正文2>", deck: "<deck2>", chapter: "<chapter2>" },
] })
markji_cards({ action: "update", updates: [
  { card: "<id1>", content: "<新正文1>" },
  { card: "<id2>", content: "<新正文2>" },
] })
markji_cards({ action: "archive", cards: ["<id1>", "<id2>"] })
markji_cards({ action: "move", cards: ["<id1>", "<id2>"], to_chapter: "<chapter>" })
```

- 单次最多 50 项（多卡读取、`new_cards`、`updates`、冲突批量解决）；归档和移动使用非空数组。`action=get` 会去重并保持请求顺序，未知 id 放入 `missing`，不会中断整批。
- `action=create` 的顶层 `deck` / `chapter` 是默认值，可以省略；每个 `new_cards` 项可写自己的 `deck` / `chapter`，所以一次调用能跨章节 / 卡组。未提供目标的项会逐条报错；每项的 `order` 相对于该项最终的目标章节。
- 结果逐项列出 `ok`、`warnings` 和错误；写操作不是事务，坏项（语法错误、媒体缺失、目标不存在）不会入队，其他项仍会排队。成功项仍需 `markji_sync({ action: "start" })` 推送。
- `action=get` 默认不返回冗余的 `text`，需要时传 `include_text: true`。
- `create` / `update` 默认同时做语法和媒体校验；媒体查询失败时该条返回 `media_check_failed`，可重试。`checkMediaOnWrite: false` 可跳过这道额外查询，但 `markji_sync` 推送前仍会检查。
- 批量输出可能超过 `maxOutputChars`，内容多时请拆小批次。

## 工具

插件只注册 4 个工具，具体操作由 `action` 选择；省略时用各工具的默认 action。

| 工具 | 默认 action | 作用 |
| --- | --- | --- |
| `markji_decks` | `list` | 卡组列表 / 详情，章节列表 / 详情 / 新建 / 重命名 / 排序 |
| `markji_cards` | `list` | 卡片列表过滤、读取、新建、修改、移动、归档、语法帮助 |
| `markji_sync` | `start` | 启动同步、等待任务、查看进度 / 插件状态 / 失败、解决冲突 |
| `markji_file` | 无（必填） | 上传文件到 Markji 或查询文件信息 |

### 各 action 一览

| 工具 | action | 作用 |
| --- | --- | --- |
| `markji_decks` | `list` | 列出文件夹与卡组 |
| `markji_decks` | `get` | 读一个卡组及其章节 |
| `markji_decks` | `chapter_list` | 列出一个或全部卡组的章节 |
| `markji_decks` | `chapter_get` | 读一个章节，可带卡片摘要 |
| `markji_decks` | `chapter_create` / `chapter_rename` / `chapter_sort` | 新建 / 重命名 / 排序章节 |
| `markji_cards` | `list` | 分页、按范围（全库 / 卡组 / 章节）过滤，使用 `filter` JSON 条件树；可同时按卡组名 / 章节名 / 更新时间过滤 |
| `markji_cards` | `get` | 按 id 读一张或多张卡；未知 id 列入 `missing` |
| `markji_cards` | `create` | 用 `new_cards` 批量新建，支持跨章节 / 卡组 |
| `markji_cards` | `update` | 改一张（`card` + `content`）或多张（`updates`） |
| `markji_cards` | `move` / `archive` | 移动到其他章节 / 归档到「归档」章节 |
| `markji_cards` | `syntax_help` | 查原始 Markji 语法；create/update 自动校验 |
| `markji_sync` | `start` | 启动后台同步（pull / push / auto，可 resume） |
| `markji_sync` | `wait` | 等待指定同步任务结束；`timeout_ms` 控制最长等待，超时返回 `task.timed_out: true` |
| `markji_sync` | `progress` | 查看同步任务进度与历史 |
| `markji_sync` | `state` | 插件与缓存总览 |
| `markji_sync` | `failures` | 查看失败卡片、冲突与恢复建议 |
| `markji_sync` | `resolve` | 解决一个或批量冲突（keep_local / keep_remote / use_content；`ids` / `items` 最多 50 个） |
| `markji_file` | `upload` / `query` | 上传文件 / 查询文件信息 |

## 工具参数与返回值

`?` 表示可选参数。id 都是 Markji OpenAPI id；尚未推送的新对象使用 `local_*` id。工具结果统一为 JSON，超过 `maxOutputChars` 会截断。下表的“参数”列只列该 action 用到的字段；同一工具的其他字段在别的 action 生效。

| 工具 / action | 参数 | 返回（主要字段） |
| --- | --- | --- |
| `markji_decks` / `list` | `refresh?` `folder_id?` `scope?` `filter?` | `{folders, decks, total}`；`folders` 为 `{id, name, deck_count, parent_id?}` |
| `markji_decks` / `get` | `deck` `refresh?` | `{deck, chapters}`；详情含 `description` / `updated_time` |
| `markji_decks` / `chapter_list` | `deck?` `scope?` `refresh?` `filter?` | 指定 `deck`：`{deck_id, deck_name, chapters, total}`；不指定：`{decks, total}` |
| `markji_decks` / `chapter_get` | `chapter` `deck?` `with_cards?` `refresh?` | `{deck_id, deck_name, chapter, cards?, total?}` |
| `markji_decks` / `chapter_create` | `deck` `name` `order?` | `{ok, action, chapter_id, deck_id, status, pending, message}` |
| `markji_decks` / `chapter_rename` | `chapter` `name` `deck?` | `{ok, action, chapter_id, status, pending, message}` |
| `markji_decks` / `chapter_sort` | `deck` `chapter_ids` | `{ok, action, deck_id, chapters, status, pending, message}` |
| `markji_cards` / `list` | `scope?` `deck?` `chapter?` `filter?` `deck_name?` `chapter_name?` `updated_after?` `updated_before?` `limit?` `offset?` `refresh?` | `{total, offset, limit, has_more, cards}`；无结果且传了 `filter` 时带 `hint` |
| `markji_cards` / `get` | `card?` `cards?`（1-50，去重）`include_text?` | `{cards, missing?}`；`missing` 仅在存在未知 id 时出现 |
| `markji_cards` / `create` | `new_cards`（1-50；每项 `{content, deck?, chapter?, order?, grammar_version?}`）；顶层 `deck?` `chapter?` 是默认值 | `{ok, action, mode, deck_id, chapter_id, total, created, failed, partial, results}`；失败项含 `errors` / `warnings` / `media`，语法或媒体失败不入队 |
| `markji_cards` / `update` | `card` `content` `grammar_version?`，或 `updates`（1-50，每项 `{card, content, grammar_version?}`） | 单条：`{ok, card_id, status, changed, pending, message, warnings?}`；批量：`{ok, action, mode, total, updated, unchanged, failed, partial, results}`；失败项不入队 |
| `markji_cards` / `move` | `cards` `to_chapter` `deck?` `order?` | `{ok, moved, to_chapter_id, status, pending, message}` |
| `markji_cards` / `archive` | `cards`（非空数组） | `{ok, archived, content_updated, already_archived, moved, chapters, status, pending, message}` |
| `markji_cards` / `syntax_help` | `format?` | `{ok, action, format, rules, nesting, formats}` |
| `markji_sync` / `start` | `mode?: auto/pull/push` `full?` `resume?` | `{task, job_id?, already_running?}`；`job_id` 需要 DSH 后台任务支持 |
| `markji_sync` / `wait` | `task_id` `timeout_ms?` | `{task}`；超时仍在运行时 `task.timed_out: true` |
| `markji_sync` / `progress` | `task_id?` | 有 `task_id`：`{task}`；无：`{active, tasks}` |
| `markji_sync` / `state` | 无 | `{version, configured, cache_file, cache, pending, conflicts, last_sync, last_error, active_task, tasks, auto_sync}` |
| `markji_sync` / `failures` | `card?` `deck?` `limit?` | `{ok, summary, conflicts, failed_cards, last_task_errors, batch_arguments, truncated?}`；每个冲突自带单条 `recovery.arguments`、`recovery.batch_arguments`；顶层 `batch_arguments` 可一次解决前 50 个 |
| `markji_sync` / `resolve` | `id`（单条）；或 `ids` + `strategy`；或 `items: [{id, strategy, content?}]`（≤50，逐条策略） | 单条保持 `{ok, id, entity, strategy, state, changed}`；批量 `{ok, total, resolved, failed, results:[{id, ok, changed, state?, strategy?, error?}]}` |
| `markji_file` / `upload` | `path` `deck?` | `{file}` |
| `markji_file` / `query` | `ids` `expires?` | `{files}` |

### `filter` 字段

`filter` 条件的 `field` 可用点号读取嵌套自有属性；不同列表允许的根字段：

- 卡片：`id`、`deck_id`、`deck_name`、`chapter_id`、`chapter_name`、`text`、`content`、`snippet`、`status`、`grammar_version`、`revision`、`updated_time`、`created_time`、`local`、`pending`、`conflict`、`last_error`、`cloud`（可继续读 `cloud.revision` 等）。
- 卡组：`id`、`name`、`description`、`folder_id`、`card_count`、`chapter_count`、`is_private`、`source`、`status`、`missing`、`created_time`、`updated_time`。
- 章节：`id`、`deck_id`、`name`、`card_count`、`order`、`revision`、`local`、`pending`、`missing`、`updated_time`（没有 `description` 和 `deck_name`）。

各 list 的字段集按资源独立维护；例如给章节传 `description` / `deck_name`，或给卡组传 `text` / `content`，都会报 `invalid_argument`，不会被静默忽略。

字符串比较默认大小写不敏感（`case_sensitive: true` 可关闭）；正则默认 `i`，可用 `flags` 覆盖；数字按数值比较；ISO 时间按字符串比较（同一时区偏移下顺序正确）；未知字段、未知 op、超过深度 / 节点限制都会以 `invalid_argument` 报错。

### 语法帮助

用 `markji_cards` 的 `syntax_help` 查询静态语法：

```text
markji_cards({ action: "syntax_help" })                     // 全部格式
markji_cards({ action: "syntax_help", format: "picture" })  // 只查图片
```

`create` / `update` 在入队前自动校验语法和媒体引用；语法错误会直接返回带行号 / 列号的 `errors`，该条不入队。

`action=syntax_help` 时 `format` 可省略或写 `all`；写 `basic` 只返回通用规则和嵌套限制。支持的格式 id 为 `text-style`、`cloze`、`audio`、`card-ref`、`paragraph`、`choice`、`picture`、`formula`、`answer-line`，也接受对应标签（如 `Pic`）和中文别名（如 `图片`）。帮助内容是静态的，不会检查或改写正文；语法以 [Markji 制卡语法指南](https://tutuji333.github.io/markji-faq/questions/content/card-syntax-guide/) 为准。

### 返回结构

```text
DeckView = {
  id, name, card_count, chapter_count,
  folder_id?, description?, updated_time?,
  is_private?, source?, status?, missing?,
}

ChapterView = {
  id, name, card_count,
  pending?: { op, name }, local?, missing?,
  revision?, order?, updated_time?,
}

CardSummary = {
  id, deck_name, chapter_name, snippet,
  status?: "dirty" | "new" | "conflict",
}

CardView = {
  id, deck_id, deck_name, chapter_id, chapter_name,
  content: string, text: string, grammar_version: number,
  status, cloud: null | { revision, updated_time },
  created_time, updated_time,
  local?, pending?, conflict?, last_error?,
}

ConflictView = {
  id, kind, entity, deck_id, chapter_id, card_id, op,
  local, remote, state, detected_at,
  deck_name, chapter_name, card_snippet,
  recovery: { tool, arguments, strategies, hint },
}

SyncTask = {
  task_id, status: "running" | "completed" | "failed" | "interrupted",
  mode: "auto" | "pull" | "push", stage,
  started_at, finished_at, resume_count,
  progress: {
    message, decks_total, decks_done,
    push_stage?, push_done?, push_total?,   // 推送阶段与当前项/总数
    chapters?, cards?, cards_deleted?, adopted_cards?, adopted_chapters?,
    conflicts_created?, chapters_created?, chapters_renamed?, chapters_sorted?,
    cards_created?, cards_updated?, cards_moved?, errors?,
  },
  full?, error?: { code, message }, hint?,
  report?: SyncReport,
}

SyncReport = {
  ok, mode, duration_ms,
  pull?: {
    decks?, chapters?, cards?, cards_deleted?,
    adopted_cards?, adopted_chapters?, conflicts?,
  },
  push?: {
    chapters_created?, chapters_renamed?, chapters_sorted?,
    cards_created?, cards_updated?, cards_moved?, conflicts?,
    errors?: [{ op, id, code, message }], errors_total?,
  },
  conflicts?: [ConflictView],
  errors?: [{ op, id, code, message }], errors_total?,
}

Status = {
  version, configured, cache_file,
  cache: {
    decks, chapters, cards, bytes, pulled_at,
    stale?, error?, save_error?,
  },
  pending: {
    cards_new?, cards_dirty?, chapters_new?, chapters_rename?,
    moves?, sorts?, conflicts?,
  },
  conflicts: [ConflictView],
  last_sync: { ok, mode, started_at, finished_at, duration_ms, conflicts, errors }|null,
  last_error: null | { code, message },
  active_task: string|null, tasks: [SyncTask],
  auto_sync: { enabled, running },
}

Failures = {
  ok, summary: { conflicts, failed_cards, last_task_errors, last_error },
  conflicts: [ConflictView],
  failed_cards: [{
    id, deck_id, deck_name, chapter_id, chapter_name,
    status, snippet,
    error: { code, message },
    recovery: { tool, arguments, strategies, hint },
  }],
  last_task_errors: [{ task_id, op, id, code, message }],
  truncated?: boolean,
}
```

`markji_cards({ action: "archive" })` 的 `chapters` 是 `[{ deck_id, chapter_id, chapter_name, local }]`。`markji_file` 的 `file` 由 Markji 返回，常见字段为 `id`、`url`、`mime`、`size`、`info`、`expire_time`。

## 配置

默认配置写在 bundle 的 `cordis.patch.yml`，都可用默认值：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 是否注册工具并启动自动同步 |
| `apiKey` | `''` | 可选的引导输入；通常用插件详情页保存 Key，这里保持空 |
| `baseUrl` | `https://open.maimemo.com/open` | API 地址 |
| `dataDir` | `<home>/.dsh/dsh-markji-bridge` | 默认缓存目录；插件详情页保存的目录优先 |
| `checkMediaOnWrite` | `true` | create/update 入队前查询媒体文件；false 可省一次请求 |
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
- `markji_sync mode=auto`：先拉取远端并三方合并，再推送本地队列；推送前一定会先拉取，避免本地缓存覆盖远端修改。
- `create` / `update` 入队前会校验语法，并默认批量调用 `POST /api/v1/markji/files/query` 检查 `Pic#ID/...`、`Pic#ID/...,MID/...` 和 `Audio#...,ID/...` 里的文件 id；失败条目不入队，批量其他项继续。推送卡片前仍会做同一套语法 + 媒体预检作为最后一道闸（防止入队后文件被删），失败时卡片保持待推送，`markji_sync({ action: "failures" })` 会给出错误与恢复建议。
- 冲突不会阻塞其他卡片，处理方式：`keep_local`（保留本地，下次推送覆盖云端）、`keep_remote`（采用云端，丢弃本地改动）、`use_content`（用指定内容替换本地待推送内容）。批量解决用 `markji_sync({ action: "resolve", ids: [...], strategy: "keep_remote" })`，或 `items: [{ id, strategy, content? }]` 混用策略，单次最多 50 个；单条 `id` 调用保持旧结构。
- 同步任务会记录进度与结果，最多保留最近 20 条；进程中断后任务标记为 `interrupted`，用 `markji_sync resume=<task_id>` 续跑。等待某个任务结束用 `markji_sync({ action: "wait", task_id })`，不要反复轮询。
- 失败或冲突用 `markji_sync({ action: "failures" })` 查看，处理完再执行 `markji_sync({ action: "start", mode: "push" })`。

## 性能与行为

- 读操作优先读本地缓存；缓存超过 `pullTtlMs`（默认 10 分钟）或显式 `refresh: true` 时先做增量拉取。
- 未知 id 触发的兜底刷新只拉取“云端标记为变化”的卡组，不会全量拉取所有卡组。实测 5265 张卡 / 82 章节的账号：未知章节重命名约 0.8 秒返回 `unknown_chapter`，未知卡片约 0.3 秒。
- 确实需要全量刷新时显式运行 `markji_sync({ action: "start", mode: "pull", full: true })`；全量拉取是后台任务，先返回 `task`，再用 `markji_sync({ action: "wait", task_id })` 等待结束，或用 `action: "progress"` 查进度。
- 写操作只改本地缓存并立即返回，网络请求发生在同步任务或自动同步里。
- 自动同步：最近一次工具调用后静默 `idleQuietMs`（默认 2 分钟）触发；无待办时每 `autoPullMs`（默认 15 分钟）拉取；失败后按 `retryBackoffMs`（默认 5 分钟）重试。
- 有未解决冲突时自动推送暂停，但拉取继续。
- 请求受滑动窗口限流（默认每 10 秒 18 次、每分钟 36 次、每 5 小时 7800 次），并发同步会自动排队。
- 单张卡内容上限 100000 字符；`markji_cards` 的 `list` 的 `limit` 上限 200，批量入口单次最多 50 项（归档 / 移动不受此限）。

## 错误码与故障排查

工具错误一般形如 `markji: <code>: <message> (hint: ...)`；参数格式错误可能是普通的 `markji_xxx: "field" ...` 消息（没有 code）。常见 code：

| code | 含义与处理 |
| --- | --- |
| `not_configured` | 没有可用的 API Key。打开 DSH 的「插件 → 墨墨记忆卡桥接」详情页，填入 64 位 Key 并「保存并测试」；不需要设置环境变量或改配置文件。 |
| `unknown_deck` / `unknown_chapter` / `unknown_card` / `unknown_folder` | 本地缓存里没有这个 id。兜底刷新已尝试过；如果对象是在其他设备新建的，执行 `markji_sync({ action: "start", mode: "pull", full: true })` 后再试。 |
| `invalid_argument` | 参数缺失、类型不对、时间格式不对、`chapter_ids` 没有列全、内容为空或超过 100000 字符等。按消息修正参数。 |
| `invalid_content` | 卡片内容不合法（例如规范化后为空）。 |
| `invalid_card_content` | 卡片正文未通过原始 Markji 语法校验。`create` / `update` 会直接返回带行号 / 列号的 `errors` 且不入队；修正后重试。 |
| `media_unavailable` | 正文引用的图片 / 遮罩 / 音频文件 id 在 Markji 查不到。`create` / `update` 会直接失败且不入队；先用 `markji_file` 上传，拿到 `file.id` 后更新正文。 |
| `media_check_failed` | 查询媒体文件失败（网络、鉴权等）。写入条目不进队列，重试即可；推送阶段的失败会保留队列。 |
| `secret_corrupt` / `secret_key_invalid` / `secret_key_missing` | `cache.db` 里的密文、`secret.key` 或宿主凭据中的 DEK 无法使用（文件损坏、被替换、换了用户 profile 或 DEK 丢失）。插件详情页重新保存 API Key；插件不会静默换新密钥，也不会回退到环境变量。 |
| `conflict_open` | 这张卡有未解决冲突。先用 `markji_sync({ action: "resolve" })` 处理。 |
| `unknown_conflict` | 冲突 id 不存在或已解决。用 `markji_sync({ action: "failures" })` 重新获取当前冲突列表。 |
| `unknown_task` / `task_not_resumable` | `resume` / `wait` 的任务 id 不存在，或该任务不是 `interrupted` / 已结束。用 `markji_sync({ action: "progress" })` 查任务状态。 |
| `deck_mismatch` | 目标章节或卡片不属于指定卡组。检查 id 与 `deck` 参数是否匹配。 |
| `cache_busy` | 另一个 DSH 进程正持有 `cache.write.lock`。等它结束再重试；不要手工删除活动进程的锁。 |
| `engine_unavailable` | 插件引擎没有加载完整。停用再启用插件，或重启 DSH。 |
| `conflict_resolve_failed` | 解决冲突时写入失败，详情见消息；通常可重试或改用 `keep_remote`。 |
| `bad_response` | Markji 返回了无法解析的数据。重试；持续出现时检查 `baseUrl` 和网络。 |
| `common_*` | Markji 服务端错误码（如 `common_unauthorized`、`common_invalid_res_id`、`common_revision_mismatch`），以服务端返回的 code 和消息为准。 |
| `ENOENT` | `markji_file` 上传的本地路径不存在。 |

常见问题：

- **`markji_sync({ action: "state" })` 里 `configured: false`**：打开「插件 → 墨墨记忆卡桥接」详情页，填入 Key 并保存；插件详情页显示 `secret_corrupt` / `secret_key_invalid` / `secret_key_missing` 时重新保存一次。可选环境变量在首次启动时读取并清除。
- **401 / 403**：token 无效、过期或没有 OpenAPI 权限；到开放平台重新生成。不要把 token 写进 `cordis.patch.yml` 或提交到仓库。
- **首次调用很慢**：首次要拉取全部卡组、章节和卡片；几千张卡通常需要几十秒到几分钟，属正常。用后台任务和 `markji_sync({ action: "wait", task_id })` / `action: "progress"` 观察，不要重复发起。
- **刚在手机 / 网页新建的卡本地找不到**：兜底刷新只拉变化的卡组，若卡组 `updated_time` 没变，执行 `markji_sync({ action: "start", mode: "pull", full: true })`。
- **自动同步没有推送**：先看 `markji_sync({ action: "failures" })` 是否有开放冲突；有冲突时推送会暂停。解决后执行 `markji_sync({ action: "start", mode: "push" })`。
- **`cache_busy` 持续出现**：确认是否有另一个 DSH 进程在使用同一 `dataDir`；关闭多余进程。进程崩溃留下的锁会按持有者 pid / 主机名判断后回收。
- **缓存损坏**：插件会把原库改名备份并重建，然后重新拉取；看 DSH 日志和 `markji_sync({ action: "state" }).last_error` 确认。
- **WSL 中使用**：DSH 本身要运行在该 WSL 发行版的 Linux 环境里；在插件详情页填 Key 即可。SQLite 缓存建议放在 Linux 文件系统（如 `~/.dsh/...`），不要放在 `/mnt/c` 下，避免文件锁和性能问题。

## 数据与隐私

- 缓存位于 `<dataDir>/cache.db`（默认 `~/.dsh/dsh-markji-bridge`），只保存在本机，除 Markji API 外不发送到任何地方。
- API Key 只以 AES-256-GCM 密文保存在 `cache.db` 的 `secrets` 表；数据密钥由 DSH 凭据服务（`dsh-markji-bridge/dek`）或仅当前用户可读的 `secret.key` 保存。插件不会把明文 Key 写入缓存、配置文件或日志，日志中的 Key 会替换为 `<redacted>`。
- 多个 DSH 进程可共享缓存目录，写入用 `cache.write.lock` 串行；不建议跨机器共享。
- 缓存损坏时会改名保存并重新拉取。

## 已知限制

- Markji OpenAPI 不支持创建 / 删除卡组、删除卡片、删除章节；章节只支持新建 / 重命名 / 排序，这些删除操作仍需在网页或客户端完成。
- 只支持单个 Markji 账号。
- 冲突需手动解决，未解决时自动推送会暂停。
- `grammarVersion` 是全局默认值，卡片自身版本未知时使用。

## 平台验证

| 环境 | 结果 |
| --- | --- |
| Windows + Node 25.2.1 | 单元 155/155，E2E 13/13，入口冒烟 4 个工具；真实 DSH 中核对 `markji_cards` / `markji_decks` 的 `filter`（equality、contains、regex、跨资源字段拒绝、未知字段拒绝），并确认插件设置区、工具注册和缓存读取正常。 |
| WSL2 Ubuntu 26.04（Linux 6.18，Node v22.22.1） | 未在当前环境实机复跑；代码只使用 Node 内置模块。 |
| macOS | 未实机测试；代码只使用 Node 内置模块，理论上可用。 |

## 开发与测试

需要 Node >= 22.13，从仓库源码运行：

```bash
node --test "test/*.test.js"   # 单元 / 集成测试（155 项）
node test/e2e-mock.mjs         # mock 服务端端到端（13 项）
node test/index-smoke.mjs      # 入口烟测（4 个工具）
```

另有一套不随仓库发布的内部独立验证集，用于发布前交叉检查；公开仓库只包含上面列出的测试。

测试需要从本仓库源码运行。主要文件：`index.js`（入口与配置）、`lib/api.js`（HTTP 客户端）、`lib/store.js`（缓存、写锁与 secrets 表）、`lib/sync.js`（同步引擎）、`lib/filter.js`（JSON 条件树与正则匹配）、`lib/jobs.js`（DSH 后台任务桥接）、`lib/plain-text.js`（纯文本转换）、`lib/card-syntax.js`（原始语法校验）、`lib/preflight.js`（写入前语法 + 媒体预检）、`lib/secret.js`（AES-256-GCM）、`lib/settings.js`（设置 RPC）、`client.js`（插件详情页配置区）、`lib/tools.js`（工具定义）。模块契约见 [DESIGN.md](./DESIGN.md)。

## 许可

MIT，见 [LICENSE](./LICENSE)。