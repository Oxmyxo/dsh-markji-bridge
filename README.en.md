[中文](README.md) | **English**

# dsh-markji-bridge

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/oxmyxo/dsh-markji-bridge) [![dsh.so install · dsh 0.2.1-rc.2](https://www.dsh.so/badge/install/dsh-markji-bridge@0.2.1-rc.2.svg)](https://www.dsh.so/artifact/dsh-markji-bridge/) [![dsh.so risk](https://www.dsh.so/badge/dsh-markji-bridge.svg)](https://www.dsh.so/artifact/dsh-markji-bridge/)

A Markji (maimemo) flashcard plugin for DeepSeek Harness (DSH) agents. It maintains a local cache of decks, chapters, and cards, so an agent can search, read, create, update, and archive cards. Every edit is written to a local queue first, then synced to the cloud in a pull → three-way merge → push order. Conflicts are reported separately and never block the rest of the cards.

Four action-based `markji_*` tools, implemented with Node.js built-in modules only, with no third-party dependencies: `markji_decks` (decks and chapters, including chapter detail, create, rename, and sort), `markji_cards` (list filters, reads, writes, syntax, archive, and move), `markji_sync` (sync, waiting, progress, state, failures, and conflicts), and `markji_file` (files). Use `markji_cards({ action: "syntax_help" })` to look up raw Markji syntax; `create` / `update` validate syntax and media references before queueing, so no separate validation call is needed.

## Features

- **Local cache**: one SQLite file, `cache.db`, stores indexes, card bodies, the pending queue, conflicts, and sync tasks. Routine searches and reads do not call the API.
- **Unified list filtering (JSON condition tree)**: card `list`, deck `list`, and `chapter_list` all take one `filter` parameter, each with its own field set; there is no separate `search` action; every filter is expressed through `filter`:
  - `filter`: a JSON condition tree, never JavaScript. A condition is `{ field, op, value, case_sensitive?, flags? }`; groups are `{ all: [...] }` / `{ any: [...] }` / `{ not: {...} }`; ops are `eq`, `ne`, `contains`, `starts_with`, `ends_with`, `regex`, `in`, `not_in`, `gt`, `gte`, `lt`, `lte`, and `exists`. Regex `flags` accepts `imsu` (default `i`), and `case_sensitive: true` disables the default case-insensitive string/regex matching. Omit `filter` or pass `{}` to list everything.
  - `scope`: cards accept `all` / `deck` / `chapter`, chapters accept `all` / `deck`, and decks accept `all` / `folder`. When omitted it is inferred from `deck` / `chapter` / `folder_id`; an explicit conflict is an error.
  - Each list owns its field set: decks only accept deck fields (`name` / `description` / `id`, times, counts, and so on), chapters only accept chapter fields (there is no `description` and no `deck_name`; use `scope=deck` to narrow by parent deck), and cards keep the wider set (`text` / `content` / `cloud` / `status`, and so on). Fields or ops that do not belong to that list fail with `invalid_argument`; they are never matched across resources.
- **Plain-text matching**: each card also stores a plain-text column with formatting markers, image/audio markers, data URIs, and base64 removed, so the `text` field stays clean and readable; `content` keeps the original rich text for regex matches against the whole body.
- **Safe writes**: edits are queued; before pushing, remote changes are pulled and three-way merged, so stale data never overwrites the cloud. Conflicts are deduplicated per card and can be resolved individually.
- **Plugin page and encrypted credentials**: the plugin's detail page accepts a Markji API Key and lets you choose the `cache.db` directory. The key is stored only as AES-256-GCM ciphertext in the `secrets` table inside `cache.db`; the data key lives in the DSH credentials service or in a user-only-readable `secret.key`, so no plaintext token appears in config files or source.
- **Automatic write preflight and media check**: `markji_cards action=syntax_help` returns the raw Markji syntax for one format or all formats. `create` / `update` validate every body before queueing and, by default, batch-query the `Pic` / `Audio` file ids (`checkMediaOnWrite: false` skips the media query). Syntax errors, missing files, and failed queries fail that item without creating a pending card, while the rest of the batch continues. `markji_sync` keeps the same preflight before pushing as the final gate.
- **Background sync**: a sync task returns a handle immediately and exposes progress. After a crash or plugin restart, resume with the same handle without creating duplicate cloud objects. When DSH loads `dsh-tool-jobs`, `markji_sync({ action: "start" })` also registers the task as a DSH background job owned by the calling session and returns `job_id`; it appears in the running-background-jobs list, `job_output` appends live progress as the sync advances, showing the current stage and `done/total` (for example `2/5 decks` while pulling or `cards_create 12/50` while pushing), and DSH sends the standard completion notice. You can also block on the task with `markji_sync({ action: "wait", task_id })` (optional `timeout_ms`; a timeout returns `task.timed_out: true`). Killing that job cancels the sync at its next checkpoint, marks the stored task `interrupted`, and leaves it resumable.
- **Archive and chapter operations**: `markji_cards({ action: "archive" })` moves cards into the same deck's "Archive" chapter and inserts an archive note into the body; repeated calls are idempotent. `markji_decks` supports chapter detail, create, rename, and sort (the provider has no chapter-delete endpoint).
- **Multi-process safety**: multiple DSH processes on one machine can share a cache directory; writes are serialized with a file lock.

## Requirements

- DSH 0.2.x host plugin environment
- Node **>= 22.13** (uses the built-in `node:sqlite`; no startup flags required)
- Windows / macOS / Linux

## Installation

Clone the source from GitHub, then install the directory as a DSH bundle:

```bash
git clone https://github.com/Oxmyxo/dsh-markji-bridge.git dsh-markji-bridge
```

```text
plugin_manager install_bundle  target=<absolute path to the repository>
```

Upgrade:

```bash
git pull
```

```text
plugin_manager remove_bundle   target=dsh-markji-bridge
plugin_manager install_bundle  target=<absolute path to the repository>
```

If only code under `lib/` changed, disable and re-enable the plugin to load the new code:

```text
plugin_manager set_plugin  target=include:dsh-markji-bridge  enabled=false
plugin_manager set_plugin  target=include:dsh-markji-bridge  enabled=true
```

## API Key and cache location

Open **Plugins → Markji bridge** and its detail page, enter the Markji OpenAPI Key (get one from the [Maimemo Open Platform](https://open.maimemo.com/)), and click "Save and test". The plugin first calls a read-only endpoint to validate it, then encrypts it with AES-256-GCM into the `secrets` table in `cache.db`; the page only shows `hasKey` and the last four characters, never the plaintext.

The same detail page lets you choose the `cache.db` directory. Changing it copies the current `cache.db` (and `secret.key`, when the file DEK is used) to the target, keeps the original directory for rollback, and requires a DSH restart.

> Optional bootstrap configuration: `apiKey` in `cordis.patch.yml` and the environment variables `MAIMEMO_MARKJI_OPENAPI_TOKEN` / `MAIMEMO_OPENAPI_TOKEN` can supply the key on first startup. The plugin encrypts the value into `cache.db` and clears it from the process environment. Prefer saving the key on the plugin detail page. Never commit a token.

## Quick start

```text
markji_decks({ action: "list", refresh: true })
markji_decks({ action: "get", deck: "<deck_id>" })
markji_decks({ action: "chapter_get", chapter: "<chapter_id>", with_cards: true })
markji_cards({ action: "list", filter: { field: "text", op: "contains", value: "sorting" }, deck_name: "Algorithms" })
markji_decks({ action: "list", filter: { field: "name", op: "contains", value: "Algorithms" } })
markji_decks({ action: "chapter_list", filter: { field: "name", op: "regex", value: "^SPI\s+clock" } })
markji_cards({ action: "list", scope: "deck", deck: "<deck_id>", filter: { all: [{ field: "status", op: "eq", value: "dirty" }, { field: "updated_time", op: "gte", value: "2026-10-01" }] } })
markji_cards({ action: "get", card: "<card_id>" })
markji_cards({ action: "get", cards: ["<card_id_1>", "<card_id_2>"] })
markji_cards({ action: "syntax_help" })
markji_cards({ action: "syntax_help", format: "picture" })
markji_cards({ action: "create", deck: "<deck>", chapter: "<chapter>", new_cards: [{ content: "<Markji rich text>" }] })
markji_sync({ action: "start", mode: "auto" })
markji_sync({ action: "wait", task_id: "<task_id>", timeout_ms: 300000 })
```

The first call pulls cloud data (it can take a while for large accounts); later reads use the local cache. Use `markji_sync({ action: "state" })` / `markji_sync({ action: "progress" })` to inspect state and progress; with `task_id` the result is only `{ task }`, without it `{ active, tasks }`. `action: "wait"` blocks until the named task finishes; without `timeout_ms` it waits at most 30 minutes (the tool timeout), then returns the still-running `task` with `timed_out: true`. When DSH loads `dsh-tool-jobs`, `start` also returns `job_id`: progress appears in DSH's background-jobs list, `job_output` appends live progress, a completion notice is delivered automatically, and `job_output` carries the final result.

## Batch operations

Use these `markji_cards` actions when several cards are involved:

```text
markji_cards({ action: "get", cards: ["<id1>", "<id2>"] })
markji_cards({ action: "create", deck: "<deck>", chapter: "<chapter>", new_cards: [
  { content: "<body1>" },
  { content: "<body2>", deck: "<deck2>", chapter: "<chapter2>" },
] })
markji_cards({ action: "update", updates: [
  { card: "<id1>", content: "<new body1>" },
  { card: "<id2>", content: "<new body2>" },
] })
markji_cards({ action: "archive", cards: ["<id1>", "<id2>"] })
markji_cards({ action: "move", cards: ["<id1>", "<id2>"], to_chapter: "<chapter>" })
```

- Batch actions accept at most 50 items (multi-card reads, `new_cards`, `updates`, bulk conflict resolution); archive and move use a non-empty array. `action=get` collapses duplicate ids and keeps request order; unknown ids are listed in `missing` and do not abort the batch.
- The top-level `deck` / `chapter` of `action=create` are optional defaults; each `new_cards` item may set its own `deck` / `chapter`, so one call can span chapters or decks. An item with no target is reported as a per-item error; each item's `order` is relative to its final target chapter.
- Results list `ok`, `warnings`, and errors per item. Writes are not a transaction: bad items (syntax errors, missing media, unknown targets) are not queued while the other items are; successful items still need `markji_sync({ action: "start" })`.
- `action=get` omits the redundant `text` view by default; pass `include_text: true` when needed.
- `create` / `update` perform both syntax and media checks by default; a failed media query returns `media_check_failed` for that item and can be retried. `checkMediaOnWrite: false` skips the extra query, but `markji_sync` still checks before pushing.
- Batch output can exceed `maxOutputChars`; split large operations into smaller batches.

## Tools

Only four tools are registered; `action` selects the operation, and omitting it uses the tool's default.

| Tool | Default action | Purpose |
| --- | --- | --- |
| `markji_decks` | `list` | Decks (list / detail) and chapters (list / detail / create / rename / sort) |
| `markji_cards` | `list` | Card list filters, read, create, update, move, archive, syntax help |
| `markji_sync` | `start` | Start sync, wait for a task, inspect progress / plugin state / failures, resolve conflicts |
| `markji_file` | none (required) | Upload a file to Markji or query file metadata |

### Actions

| Tool | Action | Purpose |
| --- | --- | --- |
| `markji_decks` | `list` | List folders and decks |
| `markji_decks` | `get` | Read one deck and its chapters |
| `markji_decks` | `chapter_list` | List chapters for one deck or for every cached deck |
| `markji_decks` | `chapter_get` | Read one chapter, optionally with card summaries |
| `markji_decks` | `chapter_create` / `chapter_rename` / `chapter_sort` | Create / rename / sort chapters |
| `markji_cards` | `list` | Paginate and filter by scope (all / deck / chapter) with a JSON `filter` condition tree; also filters by deck name, chapter name, and update time |
| `markji_cards` | `get` | Read one or several cards by id; unknown ids are listed in `missing` |
| `markji_cards` | `create` | Batch-create from `new_cards`, including across chapters or decks |
| `markji_cards` | `update` | Update one card (`card` + `content`) or several (`updates`) |
| `markji_cards` | `move` / `archive` | Move to another chapter / archive into the "Archive" chapter |
| `markji_cards` | `syntax_help` | Look up raw Markji syntax; create/update validate automatically |
| `markji_sync` | `start` | Start background sync (pull / push / auto; resumable) |
| `markji_sync` | `wait` | Wait for one sync task to finish; `timeout_ms` bounds the wait and a timeout returns `task.timed_out: true` |
| `markji_sync` | `progress` | View sync task progress and history |
| `markji_sync` | `state` | Plugin and cache overview |
| `markji_sync` | `failures` | View failed cards, conflicts, and recovery advice |
| `markji_sync` | `resolve` | Resolve one or up to 50 conflicts (keep_local / keep_remote / use_content; `ids` / `items`) |
| `markji_file` | `upload` / `query` | Upload a file / query file metadata |

## Tool parameters and return values

`?` marks an optional parameter. All ids are Markji OpenAPI ids; objects that have not been pushed yet use `local_*` ids. Tool results are JSON and are truncated when they exceed `maxOutputChars`. The parameter column lists the fields used by that action; fields for other actions of the same tool apply only there.

| Tool / action | Parameters | Returns (main fields) |
| --- | --- | --- |
| `markji_decks` / `list` | `refresh?` `folder_id?` `scope?` `filter?` | `{folders, decks, total}`; `folders` items are `{id, name, deck_count, parent_id?}` |
| `markji_decks` / `get` | `deck` `refresh?` | `{deck, chapters}`; detail includes `description` / `updated_time` |
| `markji_decks` / `chapter_list` | `deck?` `scope?` `refresh?` `filter?` | With `deck`: `{deck_id, deck_name, chapters, total}`; without: `{decks, total}` |
| `markji_decks` / `chapter_get` | `chapter` `deck?` `with_cards?` `refresh?` | `{deck_id, deck_name, chapter, cards?, total?}` |
| `markji_decks` / `chapter_create` | `deck` `name` `order?` | `{ok, action, chapter_id, deck_id, status, pending, message}` |
| `markji_decks` / `chapter_rename` | `chapter` `name` `deck?` | `{ok, action, chapter_id, status, pending, message}` |
| `markji_decks` / `chapter_sort` | `deck` `chapter_ids` | `{ok, action, deck_id, chapters, status, pending, message}` |
| `markji_cards` / `list` | `scope?` `deck?` `chapter?` `filter?` `deck_name?` `chapter_name?` `updated_after?` `updated_before?` `limit?` `offset?` `refresh?` | `{total, offset, limit, has_more, cards}`; when a filter returns nothing it also carries `hint` |
| `markji_cards` / `get` | `card?` `cards?` (1-50, deduplicated) `include_text?` | `{cards, missing?}`; `missing` appears only when some ids are unknown |
| `markji_cards` / `create` | `new_cards` (1-50; each `{content, deck?, chapter?, order?, grammar_version?}`); top-level `deck?` `chapter?` are defaults | `{ok, action, mode, deck_id, chapter_id, total, created, failed, partial, results}`; failed items carry `errors` / `warnings` / `media` and are not queued |
| `markji_cards` / `update` | `card` `content` `grammar_version?`, or `updates` (1-50, each `{card, content, grammar_version?}`) | single: `{ok, card_id, status, changed, pending, message, warnings?}`; batch: `{ok, action, mode, total, updated, unchanged, failed, partial, results}`; failed items are not queued |
| `markji_cards` / `move` | `cards` `to_chapter` `deck?` `order?` | `{ok, moved, to_chapter_id, status, pending, message}` |
| `markji_cards` / `archive` | `cards` (non-empty array) | `{ok, archived, content_updated, already_archived, moved, chapters, status, pending, message}` |
| `markji_cards` / `syntax_help` | `format?` | `{ok, action, format, rules, nesting, formats}` |
| `markji_sync` / `start` | `mode?: auto/pull/push` `full?` `resume?` | `{task, job_id?, already_running?}`; `job_id` requires DSH background-job support |
| `markji_sync` / `wait` | `task_id` `timeout_ms?` | `{task}`; while still running after a timeout, `task.timed_out: true` |
| `markji_sync` / `progress` | `task_id?` | With `task_id`: `{task}`; without: `{active, tasks}` |
| `markji_sync` / `state` | none | `{version, configured, cache_file, cache, pending, conflicts, last_sync, last_error, active_task, tasks, auto_sync}` |
| `markji_sync` / `failures` | `card?` `deck?` `limit?` | `{ok, summary, conflicts, failed_cards, last_task_errors, batch_arguments, truncated?}`; each conflict carries single `recovery.arguments` / `recovery.batch_arguments`, and the top-level `batch_arguments` resolves the first 50 in one call |
| `markji_sync` / `resolve` | `id` (single); or `ids` + `strategy`; or `items: [{id, strategy, content?}]` (≤50, per-item strategy) | single keeps `{ok, id, entity, strategy, state, changed}`; batch returns `{ok, total, resolved, failed, results:[{id, ok, changed, state?, strategy?, error?}]}` |
| `markji_file` / `upload` | `path` `deck?` | `{file}` |
| `markji_file` / `query` | `ids` `expires?` | `{files}` |

### `filter` fields

A `filter` condition's `field` supports dot paths over own properties. Allowed root fields per list:

- Cards: `id`, `deck_id`, `deck_name`, `chapter_id`, `chapter_name`, `text`, `content`, `snippet`, `status`, `grammar_version`, `revision`, `updated_time`, `created_time`, `local`, `pending`, `conflict`, `last_error`, `cloud` (for example `cloud.revision`).
- Decks: `id`, `name`, `description`, `folder_id`, `card_count`, `chapter_count`, `is_private`, `source`, `status`, `missing`, `created_time`, `updated_time`.
- Chapters: `id`, `deck_id`, `name`, `card_count`, `order`, `revision`, `local`, `pending`, `missing`, `updated_time` (no `description`, no `deck_name`).

Each list maintains its field set independently. For example, passing `description` / `deck_name` to chapters, or `text` / `content` to decks, fails with `invalid_argument` instead of being silently ignored.

String comparisons are case-insensitive by default (`case_sensitive: true` turns that off); regex defaults to `i` and `flags` overrides it; numbers compare numerically; ISO times compare as strings (correct order for one timezone offset); unknown fields or ops and trees beyond the depth / node limits fail with `invalid_argument`.

### Syntax help

Use the `syntax_help` action of `markji_cards` to query static syntax:

```text
markji_cards({ action: "syntax_help" })                     // every format
markji_cards({ action: "syntax_help", format: "picture" })  // just pictures
```

`create` / `update` validate syntax and media references before queueing. A syntax error returns `errors` with line / column and the item is not queued.

For `action=syntax_help`, omit `format` or pass `all`; pass `basic` for just the general rules and nesting matrix. Supported format ids are `text-style`, `cloze`, `audio`, `card-ref`, `paragraph`, `choice`, `picture`, `formula`, and `answer-line`; the corresponding tag (for example `Pic`) and Chinese aliases (for example `图片`) are also accepted. Help is static and never inspects or rewrites content; the syntax follows the [Markji syntax guide](https://tutuji333.github.io/markji-faq/questions/content/card-syntax-guide/).

### Return structures

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
    push_stage?, push_done?, push_total?,   // push stage and current/total items
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

For `markji_cards({ action: "archive" })`, `chapters` is `[{ deck_id, chapter_id, chapter_name, local }]`. For `markji_file`, `file` is returned by Markji; common fields are `id`, `url`, `mime`, `size`, `info`, and `expire_time`.

## Configuration

The defaults live in the bundle's `cordis.patch.yml`; all are optional:

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Whether to register the tools and start auto sync |
| `apiKey` | `''` | Optional bootstrap input; normally save the key on the plugin page and keep this empty |
| `baseUrl` | `https://open.maimemo.com/open` | API endpoint |
| `dataDir` | `<home>/.dsh/dsh-markji-bridge` | Default cache directory; a directory saved on the plugin page wins |
| `checkMediaOnWrite` | `true` | Query media files before create/update queues; false saves one request |
| `grammarVersion` | `3` | Default grammar_version for new cards |
| `requestTimeoutMs` | `20000` | Per-request timeout |
| `maxRetries` | `3` | Retries for network errors / 429 / 5xx |
| `pageSize` | `100` | Pull page size |
| `pullTtlMs` | `600000` | After the cache expires, reads trigger an incremental pull |
| `autoSync` | `true` | Push and pull automatically while idle |
| `idleCheckMs` | `30000` | Idle check interval |
| `idleQuietMs` | `120000` | Quiet time after the most recent tool call |
| `autoPullMs` | `900000` | Background pull interval when nothing is pending |
| `retryBackoffMs` | `300000` | Retry interval after a failed auto sync |
| `maxOutputChars` | `20000` | Maximum characters in one tool result |

## Sync and recovery

- Reads first do an incremental pull when the cache has expired; writes only update the local cache and enqueue changes.
- `markji_sync mode=auto`: pull and three-way merge first, then push the local queue. A pull always happens before a push, so stale data never overwrites remote changes.
- `create` / `update` validate syntax and, by default, batch-call `POST /api/v1/markji/files/query` for the ids in `Pic#ID/...`, `Pic#ID/...,MID/...`, and `Audio#...,ID/...` before queueing; failed items are not queued and the rest of the batch continues. Before pushing, the engine repeats the same syntax + media preflight as the final gate (in case a file was deleted after queueing); missing files are not written, the card stays queued, and `markji_sync({ action: "failures" })` reports the recovery steps.
- Conflicts do not block other cards. Resolve them with `keep_local` (keep the local edit and overwrite the cloud on the next push), `keep_remote` (accept the cloud version and discard the local edit), or `use_content` (replace the local pending content with the supplied content). For batches use `markji_sync({ action: "resolve", ids: [...], strategy: "keep_remote" })` or `items: [{ id, strategy, content? }]` to mix strategies, up to 50 per call; a single `id` call keeps the old shape.
- Sync tasks record progress and results, keeping the latest 20. If the process is interrupted, the task is marked `interrupted`; resume it with `markji_sync resume=<task_id>`. To wait for one task, use `markji_sync({ action: "wait", task_id })` instead of polling.
- Inspect failures or conflicts with `markji_sync({ action: "failures" })`, then run `markji_sync({ action: "start", mode: "push" })`.

## Performance and behavior

- Reads prefer the local cache. When the cache is older than `pullTtlMs` (default 10 minutes) or `refresh: true` is passed, an incremental pull runs first.
- The fallback refresh for an unknown id pulls only decks marked as changed in the cloud, never every deck. On a measured account with 5,265 cards / 82 chapters, renaming an unknown chapter returned `unknown_chapter` in about 0.8 seconds and an unknown card in about 0.3 seconds.
- When a full refresh is actually needed, run `markji_sync({ action: "start", mode: "pull", full: true })` explicitly. It is a background task: it returns a `task` first, then use `markji_sync({ action: "wait", task_id })` to wait for completion or `action: "progress"` to inspect progress.
- Writes only update the local cache and return immediately; network requests happen in sync tasks or auto sync.
- Auto sync runs after `idleQuietMs` (default 2 minutes) of quiet following the most recent tool call. When nothing is pending, it pulls every `autoPullMs` (default 15 minutes). After a failure it retries every `retryBackoffMs` (default 5 minutes).
- Open conflicts pause auto push, but pulls continue.
- Requests use a sliding-window rate limit (default 18 per 10 seconds, 36 per minute, 7,800 per 5 hours); concurrent syncs queue automatically.
- Card content is limited to 100,000 characters; `markji_cards` `list` accepts `limit` up to 200, and batch entries accept at most 50 items each (archive / move are not capped).

## Error codes and troubleshooting

Tool errors usually look like `markji: <code>: <message> (hint: ...)`; malformed arguments may produce a plain `markji_xxx: "field" ...` message without a code. Common codes:

| Code | Meaning and action |
| --- | --- |
| `not_configured` | No API Key is available. Open Plugins → Markji bridge and its detail page, enter the 64-character key, and click "Save and test"; no environment variable or config edit is needed. |
| `unknown_deck` / `unknown_chapter` / `unknown_card` / `unknown_folder` | The id is not in the local cache. The fallback refresh already ran; if the object was created on another device, run `markji_sync({ action: "start", mode: "pull", full: true })` and retry. |
| `invalid_argument` | Missing or wrongly typed argument, bad time format, incomplete `chapter_ids`, empty content, content over 100,000 characters, etc. Fix the arguments according to the message. |
| `invalid_content` | Invalid card content (for example, empty after normalization). |
| `invalid_card_content` | The card body failed raw Markji syntax validation. `create` / `update` return `errors` with line / column and do not queue the item; fix and retry. |
| `media_unavailable` | An image / mask / audio file id in the body cannot be found in Markji. `create` / `update` fail without queueing; upload it with `markji_file`, then update the body with the returned `file.id`. |
| `media_check_failed` | The media query failed (network, auth, etc.). Write items are not queued; retry. Failures during push keep the queue. |
| `secret_corrupt` / `secret_key_invalid` / `secret_key_missing` | The ciphertext in `cache.db`, `secret.key`, or the Host credential DEK cannot be used (corrupt / replaced file, different user profile, or a lost DEK). Save the API Key again on the plugin page; the plugin never silently mints a new key or falls back to the environment; do not try to splice old ciphertext back. |
| `conflict_open` | The card has an open conflict. Resolve it with `markji_sync({ action: "resolve" })` first. |
| `unknown_conflict` | The conflict id does not exist or was already resolved. Fetch the current list with `markji_sync({ action: "failures" })`. |
| `unknown_task` / `task_not_resumable` | The `resume` / `wait` task id does not exist, or the task is not `interrupted` / has already finished. Check with `markji_sync({ action: "progress" })`. |
| `deck_mismatch` | The target chapter or card does not belong to the specified deck. Check that the ids match the `deck` argument. |
| `cache_busy` | Another DSH process holds `cache.write.lock`. Wait for it to finish and retry; do not delete the lock of a live process manually. |
| `engine_unavailable` | The plugin engine did not load completely. Disable and re-enable the plugin, or restart DSH. |
| `conflict_resolve_failed` | Writing failed while resolving a conflict; see the message. Usually retry or use `keep_remote`. |
| `bad_response` | Markji returned data that could not be parsed. Retry; if it persists, check `baseUrl` and the network. |
| `common_*` | Markji server error codes (for example `common_unauthorized`, `common_invalid_res_id`, `common_revision_mismatch`); use the server's code and message. |
| `ENOENT` | The local path passed to `markji_file` does not exist. |

Common issues:

- **`configured: false` in `markji_sync({ action: "state" })`**: open Plugins → Markji bridge and its detail page, enter the key, and save. If the page reports `secret_corrupt` / `secret_key_invalid` / `secret_key_missing`, save it again. Optional environment variables are read once on first startup and cleared.
- **401 / 403**: the token is invalid, expired, or lacks OpenAPI permission; generate a new one on the platform. Do not put the token in `cordis.patch.yml` or commit it to the repository.
- **The first call is slow**: the first call pulls all decks, chapters, and cards; thousands of cards usually take tens of seconds to a few minutes, which is expected. Watch the background task with `markji_sync({ action: "wait", task_id })` / `action: "progress"` instead of starting duplicate syncs.
- **A card just created on the phone or web is missing locally**: the fallback refresh pulls only changed decks. If the deck's `updated_time` did not change, run `markji_sync({ action: "start", mode: "pull", full: true })`.
- **Auto sync is not pushing**: first check `markji_sync({ action: "failures" })` for open conflicts; auto push pauses while any are open. After resolving them, run `markji_sync({ action: "start", mode: "push" })`.
- **`cache_busy` keeps appearing**: check whether another DSH process is using the same `dataDir`; close the extra process. Locks left by a crashed process are reclaimed after checking the owner pid / hostname.
- **The cache is corrupted**: the plugin renames the original database to a backup, rebuilds it, and pulls again. Check the DSH logs and `markji_sync({ action: "state" }).last_error`.
- **Using it under WSL**: DSH itself must run inside that WSL distribution's Linux environment; enter the key on the plugin page. Keep the SQLite cache on the Linux filesystem (for example `~/.dsh/...`), not under `/mnt/c`, to avoid file-lock and performance problems.

## Data and privacy

- The cache is `<dataDir>/cache.db` (default `~/.dsh/dsh-markji-bridge`) and stays on the local machine; nothing is sent anywhere except the Markji API.
- The API Key is stored only as AES-256-GCM ciphertext in the `secrets` table inside `cache.db`; the data key lives in the DSH credentials service (`dsh-markji-bridge/dek`) or in a user-only-readable `secret.key`. The plugin never writes the plaintext key to the cache, config files, or logs, and redacts it as `<redacted>` in logs.
- Multiple DSH processes can share the cache directory; writes are serialized with `cache.write.lock`. Sharing across machines is not recommended.
- If the cache is corrupted, it is renamed to a backup and pulled again.

## Known limitations

- The Markji OpenAPI cannot create or delete decks, delete cards, or delete chapters. Chapters support create / rename / sort only; the delete operations still need the web app or client.
- Only one Markji account is supported.
- Conflicts must be resolved manually; auto push pauses while any are open.
- `grammarVersion` is a global default, used when a card's own version is unknown.

## Platform verification

| Environment | Result |
| --- | --- |
| Windows + Node 25.2.1 | Unit 155/155, E2E 13/13, entry smoke 4 tools; a live DSH check exercised `markji_cards` / `markji_decks` `filter` (equality, contains, regex, cross-resource and unknown-field rejection) and confirmed the plugin settings section, tool registration, and cached reads. |
| WSL2 Ubuntu 26.04 (Linux 6.18, Node v22.22.1) | Not re-run in this environment; the code uses only Node built-in modules. |
| macOS | Not tested on real hardware; the code uses only Node built-in modules and should work. |

## Development and testing

Node >= 22.13 is required. Run from the repository source:

```bash
node --test "test/*.test.js"   # unit / integration tests (155)
node test/e2e-mock.mjs         # mock-server end-to-end (13)
node test/index-smoke.mjs      # entry smoke test (4 tools)
```

There is also an internal independent verification suite used for pre-release cross-checking; it is not published in the repository. The public repository contains only the tests listed above.

Tests must run from the repository source. Main files: `index.js` (entry and configuration), `lib/api.js` (HTTP client), `lib/store.js` (cache, write locks, and the secrets table), `lib/sync.js` (sync engine), `lib/filter.js` (JSON condition trees and regex matching), `lib/jobs.js` (DSH background-job bridge), `lib/plain-text.js` (plain-text conversion), `lib/card-syntax.js` (raw syntax validation), `lib/preflight.js` (write preflight), `lib/secret.js` (AES-256-GCM), `lib/settings.js` (settings RPC), `client.js` (plugin-page configuration section), and `lib/tools.js` (tool definitions). The module contract is [DESIGN.md](./DESIGN.md).

## License

MIT, see [LICENSE](./LICENSE).
