[中文](README.md) | **English**

# dsh-markji-bridge

[![Listed on dsh-plugin.org](https://dsh-plugin.org/badges/listed.svg)](https://dsh-plugin.org/plugins/oxmyxo/dsh-markji-bridge) [![dsh.so install · dsh 0.2.1-rc.2](https://www.dsh.so/badge/install/dsh-markji-bridge@0.2.1-rc.2.svg)](https://www.dsh.so/artifact/dsh-markji-bridge/) [![dsh.so risk](https://www.dsh.so/badge/dsh-markji-bridge.svg)](https://www.dsh.so/artifact/dsh-markji-bridge/)

A Markji (maimemo) flashcard plugin for DeepSeek Harness (DSH) agents. It maintains a local cache of decks, chapters, and cards, so an agent can search, read, create, update, and archive cards. Every edit is written to a local queue first, then synced to the cloud in a pull → three-way merge → push order. Conflicts are reported separately and never block the rest of the cards.

Four action-based `markji_*` tools, implemented with Node.js built-in modules only, with no third-party dependencies: `markji_decks` (decks and chapters, including chapter detail, create, rename, and sort), `markji_cards` (reads, writes, search, syntax, archive, and move), `markji_sync` (sync, progress, state, failures, and conflicts), and `markji_file` (files). Use `markji_cards({ action: "syntax_help" })` to look up raw Markji syntax, then `action=validate` before writing; batch work uses the same tool's `new_cards`, `updates`, and `contents` / `cards`. Sync additionally checks that image / audio file ids referenced by the content exist in Markji.

## Features

- **Local cache**: one SQLite file, `cache.db`, stores indexes, card bodies, the pending queue, conflicts, and sync tasks. Routine searches and reads do not call the API.
- **Plain-text search**: each card also stores a plain-text column with formatting markers, image/audio markers, data URIs, and base64 removed. Search matches the plain text only, so results stay clean and readable. `markji_cards` `query_mode` supports `substring` (default), `fuzzy` (approximate matches that tolerate small typos and sort by score), and `regex` (JavaScript regular expression; `regex_flags` accepts `imsu`, default `i`). `min_score` tunes the fuzzy threshold. Keep `query` to one short phrase (usually 1-3 words): fuzzy compares the whole query, and space-separated terms must all match approximately. If 3+ terms match no card fully, fuzzy picks the rarest query terms as anchors and falls back to partial matches with `partial: true`, `fallback_terms`, and per-card `matched_terms`, plus a `hint`. Do not paste a list of concepts as a query.
- **Safe writes**: edits are queued; before pushing, remote changes are pulled and three-way merged, so stale data never overwrites the cloud. Conflicts are deduplicated per card and can be resolved individually.
- **Syntax help, batch operations, write preflight, and media check**: `markji_cards action=syntax_help` returns the raw Markji syntax for one format or all formats; `action=validate` accepts one `content`, several `contents`, or several `cards` and only validates content, never generating or rewriting it. `action=get` reads several cards at once, `action=create` accepts `new_cards` that may target different chapters or decks in one call, and `action=update` accepts an `updates` array that queues several writes. Before pushing, `markji_sync` validates each pending body again and batch-queries the `Pic` / `Audio` file ids. Syntax errors, missing files, and query failures are recorded on the card while the queue is kept, so nothing is half-written.
- **Background sync**: a sync task returns a handle immediately and exposes progress. After a crash or plugin restart, resume with the same handle without creating duplicate cloud objects. When DSH loads `dsh-tool-jobs`, `markji_sync({ action: "start" })` also registers the task as a DSH background job owned by the calling session and returns `job_id`; it appears in the running-background-jobs list, `job_output` reads it, and DSH sends the standard completion notice. Killing that job cancels the sync at its next checkpoint, marks the stored task `interrupted`, and leaves it resumable.
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

## Token configuration

Set the Markji OpenAPI token in the **DSH host process** environment (get one from the [Maimemo Open Platform](https://open.maimemo.com/)):

```powershell
# Windows: set a user environment variable, then restart DSH
setx MAIMEMO_MARKJI_OPENAPI_TOKEN "<your token>"
```

```bash
# macOS / Linux: write it to your shell profile, then reopen the terminal
export MAIMEMO_MARKJI_OPENAPI_TOKEN="<your token>"
```

Never commit the token or write it into a config file. The plugin's `apiKey` config can override the token, but it is stored in plain text in the profile; normally you do not need it.

## Quick start

```text
markji_decks({ action: "list", refresh: true })
markji_decks({ action: "get", deck: "<deck_id>" })
markji_decks({ action: "chapter_get", chapter: "<chapter_id>", with_cards: true })
markji_cards({ action: "search", query: "sorting", deck_name: "Algorithms" })
markji_cards({ action: "search", query: "variabel init", query_mode: "fuzzy" })
markji_cards({ action: "search", query: "^SPI\s+clock", query_mode: "regex" })
markji_cards({ action: "get", card: "<card_id>" })
markji_cards({ action: "get", cards: ["<card_id_1>", "<card_id_2>"] })
markji_cards({ action: "syntax_help" })
markji_cards({ action: "syntax_help", format: "picture" })
markji_cards({ action: "validate", content: "<Markji rich text>" })
markji_cards({ action: "validate", cards: ["<card_id_1>", "<card_id_2>"] })
markji_cards({ action: "validate", contents: ["<Markji rich text 1>", "<Markji rich text 2>"] })
markji_sync({ action: "start", mode: "auto" })
```

The first call pulls cloud data (it can take a while for large accounts); later reads use the local cache. Use `markji_sync({ action: "state" })` / `markji_sync({ action: "progress" })` to inspect state and progress. When DSH loads `dsh-tool-jobs`, `start` also returns `job_id`: progress appears in DSH's background-jobs list, a completion notice is delivered automatically, and `job_output` reads the result.

## Batch operations

Use these `markji_cards` actions when several cards are involved:

```text
markji_cards({ action: "get", cards: ["<id1>", "<id2>"] })
markji_cards({ action: "validate", cards: ["<id1>", "<id2>"] })              // validate existing cards
markji_cards({ action: "validate", contents: ["<body1>", "<body2>"] })        // validate bodies not written yet
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

- Batch actions accept at most 50 items (multi-card reads, syntax `contents` / `cards`, `new_cards`, `updates`); archive and move use a non-empty array. `action=get` collapses duplicate ids; unknown ids are returned as per-item errors and do not abort the batch.
- The top-level `deck` / `chapter` of `action=create` are optional defaults; each `new_cards` item may set its own `deck` / `chapter`, so one call can span chapters or decks. An item with no target is reported as a per-item error; each item's `order` is relative to its final target chapter.
- Results list `ok` and errors per item. Writes are not a transaction: bad items are reported while the other items are still queued, and successful items still need `markji_sync({ action: "start" })`.
- `action=get` omits the redundant `text` view by default; pass `include_text: true` when needed.
- Batch syntax validation is local only and does not query media availability; `markji_sync` still performs the media preflight.
- Batch output can exceed `maxOutputChars`; split large operations into smaller batches.

## Tools

Only four tools are registered; `action` selects the operation, and omitting it uses the tool's default.

| Tool | Default action | Purpose |
| --- | --- | --- |
| `markji_decks` | `list` | Decks (list / detail) and chapters (list / detail / create / rename / sort) |
| `markji_cards` | `list` | Card list, search, read, create, update, move, archive, syntax help and validation |
| `markji_sync` | `start` | Start sync, inspect progress / plugin state / failures, resolve conflicts |
| `markji_file` | none (required) | Upload a file to Markji or query file metadata |

### Actions

| Tool | Action | Purpose |
| --- | --- | --- |
| `markji_decks` | `list` | List folders and decks |
| `markji_decks` | `get` | Read one deck and its chapters |
| `markji_decks` | `chapter_list` | List chapters for one deck or for every cached deck |
| `markji_decks` | `chapter_get` | Read one chapter, optionally with card summaries |
| `markji_decks` | `chapter_create` / `chapter_rename` / `chapter_sort` | Create / rename / sort chapters |
| `markji_cards` | `list` / `search` | Paginate and filter, or search by deck name, chapter name, and update time; supports substring, fuzzy, and regex queries |
| `markji_cards` | `get` | Read one or several cards by id; unknown ids are reported per item |
| `markji_cards` | `create` | Batch-create from `new_cards`, including across chapters or decks |
| `markji_cards` | `update` | Update one card (`card` + `content`) or several (`updates`) |
| `markji_cards` | `move` / `archive` | Move to another chapter / archive into the "Archive" chapter |
| `markji_cards` | `validate` / `syntax_help` | Validate raw or cached content / look up raw Markji syntax |
| `markji_sync` | `start` | Start background sync (pull / push / auto; resumable) |
| `markji_sync` | `progress` | View sync task progress and history |
| `markji_sync` | `state` | Plugin and cache overview |
| `markji_sync` | `failures` | View failed cards, conflicts, and recovery advice |
| `markji_sync` | `resolve` | Resolve a conflict (keep_local / keep_remote / use_content) |
| `markji_file` | `upload` / `query` | Upload a file / query file metadata |

### 2.2.0: fuzzy and regex search

`markji_cards` `list` / `search` now accept `query_mode`:

- `substring` (default): case-insensitive substring, the 2.1.0 behavior.
- `fuzzy`: approximate matching that tolerates small typos, insertions, and deletions; results carry `score` (0-1) and sort best-first, and `min_score` tunes the threshold (default 0.6). It compares the whole query; space-separated terms must all match approximately, so search one short phrase at a time. When 3+ terms match no card fully, it anchors on the rarest terms and falls back to partial matches (`partial: true`, `fallback_terms`) with per-card `matched_terms`.
- `regex`: treats `query` as a JavaScript regular expression; `regex_flags` accepts `i` / `m` / `s` / `u` (default `i`).

`matched_by` reports whether the card body or id matched; `search` `filters` echoes `query_mode`, `regex_flags`, and `min_score`. `list` accepts the same query options. When nothing matches, `list` / `search` include a `hint`; a fuzzy partial fallback also sets `partial: true`, `fallback_terms`, and per-card `matched_terms`.

### 2.1.0: sync as a DSH background job

`markji_sync({ action: "start" })` now returns an optional `job_id`. When DSH loads `dsh-tool-jobs` and the call comes from a live session, the plugin registers the sync task as a DSH background job owned by that session: it appears in DSH's running background jobs, its progress follows the sync stage, `job_output` reads the task result, and DSH sends its standard completion notice when the job settles (completed, failed, or killed).

Without `dsh-tool-jobs`, or when the call does not come from a session, no `job_id` is returned and behavior is identical to 2.0.0. Killing the DSH job cancels the sync at its next checkpoint: queued edits are kept, the stored task becomes `interrupted`, and it can be resumed with `markji_sync({ action: "start", resume: "<task_id>" })`. The `progress` / `state` / `failures` / `resolve` actions remain available.

### Migrating from 1.x

2.0.0 no longer registers the fine-grained 1.x tools; replace the old call with one tool plus an `action`. Fields are unchanged except that batch creation now uses `new_cards`:

| 1.x tool | 2.0.0 call |
| --- | --- |
| `markji_chapters` / `markji_chapters_edit` | `markji_decks` `chapter_list` / `chapter_get` / `chapter_create` / `chapter_rename` / `chapter_sort` |
| `markji_search` | `markji_cards` `search` |
| `markji_card_get` / `markji_cards_get` | `markji_cards` `get` |
| `markji_card_syntax` | `markji_cards` `validate` or `syntax_help` |
| `markji_card_create` / `markji_cards_create` | `markji_cards` `create` (batch field: `new_cards`) |
| `markji_card_update` | `markji_cards` `update` |
| `markji_card_archive` / `markji_cards_move` | `markji_cards` `archive` / `move` |
| `markji_sync_status` | `markji_sync` `progress` |
| `markji_status` | `markji_sync` `state` |
| `markji_failures` | `markji_sync` `failures` |
| `markji_conflict_resolve` | `markji_sync` `resolve` |
| `markji_file` | unchanged (`action` still required) |

## Tool parameters and return values

`?` marks an optional parameter. All ids are Markji OpenAPI ids; objects that have not been pushed yet use `local_*` ids. Tool results are JSON and are truncated when they exceed `maxOutputChars`. The parameter column lists the fields used by that action; fields for other actions of the same tool apply only there.

| Tool / action | Parameters | Returns (main fields) |
| --- | --- | --- |
| `markji_decks` / `list` | `refresh?` `folder_id?` | `{folders, decks, total, cache}` |
| `markji_decks` / `get` | `deck` `refresh?` | `{deck, chapters, cache}` |
| `markji_decks` / `chapter_list` | `deck?` `refresh?` | With `deck`: `{deck_id, deck_name, chapters, cache}`; without: `{decks, cache}` |
| `markji_decks` / `chapter_get` | `chapter` `deck?` `with_cards?` `refresh?` | `{deck_id, deck_name, chapter, cards?, total?, cache}` |
| `markji_decks` / `chapter_create` | `deck` `name` `order?` | `{ok, action, chapter_id, deck_id, status, pending, message}` |
| `markji_decks` / `chapter_rename` | `chapter` `name` `deck?` | `{ok, action, chapter_id, status, pending, message}` |
| `markji_decks` / `chapter_sort` | `deck` `chapter_ids` | `{ok, action, deck_id, chapters, status, pending, message}` |
| `markji_cards` / `list` | `deck?` `chapter?` `query?` `query_mode?` `regex_flags?` `min_score?` `limit?` `offset?` | `{total, offset, limit, has_more, cards, cache}` |
| `markji_cards` / `search` | `query?` `query_mode?` `regex_flags?` `min_score?` `deck?` `deck_name?` `chapter?` `chapter_name?` `updated_after?` `updated_before?` `limit?` `offset?` `refresh?` | `{total, offset, limit, has_more, filters, cards, cache}` |
| `markji_cards` / `get` | `card?` `cards?` (1-50, deduplicated) `include_text?` | `{ok, requested, found, missing, cards, cache}`; each `cards` item is `{card_id, ok, card\|error}` |
| `markji_cards` / `create` | `new_cards` (1-50; each `{content, deck?, chapter?, order?, grammar_version?}`); top-level `deck?` `chapter?` are defaults | `{ok, action, mode, deck_id, chapter_id, total, created, failed, partial, results}`; top-level defaults are `null` when omitted |
| `markji_cards` / `update` | `card` `content` `grammar_version?`, or `updates` (1-50, each `{card, content, grammar_version?}`) | single: `{ok, card_id, status, changed, pending, message}`; batch: `{ok, action, mode, total, updated, unchanged, failed, partial, results}` |
| `markji_cards` / `move` | `cards` `to_chapter` `deck?` `order?` | `{ok, moved, to_chapter_id, status, pending, message}` |
| `markji_cards` / `archive` | `cards` (non-empty array) | `{ok, archived, content_updated, already_archived, moved, chapters, status, pending, message}` |
| `markji_cards` / `validate` | `content` or `contents` or `cards` (only one) | single: `{ok, errors, warnings, stats, media}`; batch: `{ok, action, mode, source, total, valid, invalid, missing?, syntax_invalid?, results}` |
| `markji_cards` / `syntax_help` | `format?` | `{ok, action, format, rules, nesting, formats}` |
| `markji_sync` / `start` | `mode?: auto/pull/push` `full?` `resume?` | `{task, job_id?, already_running?}`; `job_id` requires DSH background-job support |
| `markji_sync` / `progress` | `task_id?` | `{active, tasks}` |
| `markji_sync` / `state` | none | `{version, data_dir, cache_file, configured, base_url, cache, pending, conflicts, last_sync, last_error, active_task, tasks, auto_sync}` |
| `markji_sync` / `failures` | `card?` `deck?` `limit?` | `{ok, summary, conflicts, failed_cards, last_task_errors, recovery, truncated}` |
| `markji_sync` / `resolve` | `id` `strategy: keep_local/keep_remote/use_content` `content?` | `{ok, id, entity, strategy, state, changed}` |
| `markji_file` / `upload` | `path` `deck?` | `{file}` |
| `markji_file` / `query` | `ids` `expires?` | `{files}` |

### Syntax help

Use the `validate` / `syntax_help` actions of `markji_cards`:

```text
markji_cards({ action: "syntax_help" })                     // every format
markji_cards({ action: "syntax_help", format: "picture" })  // just pictures
markji_cards({ action: "validate", content: "<Markji rich text>" })      // validate content
markji_cards({ action: "validate", contents: ["<body1>", "<body2>"] })    // validate several bodies
markji_cards({ action: "validate", cards: ["<id1>", "<id2>"] })           // validate several existing cards
```

In batch mode pass only one of `content`, `contents`, or `cards`. Each item is validated independently, so one bad item does not stop the others. `cards` validates the effective body (the pending edit when one exists).

For `action=syntax_help`, omit `format` or pass `all`; pass `basic` for just the general rules and nesting matrix. Supported format ids are `text-style`, `cloze`, `audio`, `card-ref`, `paragraph`, `choice`, `picture`, `formula`, and `answer-line`; the corresponding tag (for example `Pic`) and Chinese aliases (for example `图片`) are also accepted. Help is static and never inspects or rewrites content; the syntax follows the [Markji syntax guide](https://tutuji333.github.io/markji-faq/questions/content/card-syntax-guide/).

### Return structures

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

For `markji_cards({ action: "archive" })`, `chapters` is `[{ deck_id, chapter_id, chapter_name, local }]`. For `markji_file`, `file` is returned by Markji; common fields are `id`, `url`, `mime`, `size`, `info`, and `expire_time`.

## Configuration

The defaults live in the bundle's `cordis.patch.yml`; all are optional:

| Field | Default | Description |
| --- | --- | --- |
| `enabled` | `true` | Whether to register the tools and start auto sync |
| `apiKey` | `''` | Optional token override (leave empty and use the environment variable) |
| `baseUrl` | `https://open.maimemo.com/open` | API endpoint |
| `dataDir` | `<home>/.dsh/dsh-markji-bridge` | Cache directory |
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
- Before pushing a card, the engine validates each pending body and batch-calls `POST /api/v1/markji/files/query` for the ids in `Pic#ID/...`, `Pic#ID/...,MID/...`, and `Audio#...,ID/...`. Missing files are not written; the card stays queued and `markji_sync({ action: "failures" })` reports the recovery steps.
- Conflicts do not block other cards. Resolve them with `keep_local` (keep the local edit and overwrite the cloud on the next push), `keep_remote` (accept the cloud version and discard the local edit), or `use_content` (replace the local pending content with the supplied content).
- Sync tasks record progress and results, keeping the latest 20. If the process is interrupted, the task is marked `interrupted`; resume it with `markji_sync resume=<task_id>`.
- Inspect failures or conflicts with `markji_sync({ action: "failures" })`, then run `markji_sync({ action: "start", mode: "push" })`.

## Performance and behavior

- Reads prefer the local cache. When the cache is older than `pullTtlMs` (default 10 minutes) or `refresh: true` is passed, an incremental pull runs first.
- Since 1.0.1, the fallback refresh for an unknown id pulls only decks marked as changed in the cloud, instead of pulling every deck. On a measured account with 5,265 cards / 82 chapters, renaming an unknown chapter returned `unknown_chapter` in about 0.8 seconds and an unknown card in about 0.3 seconds; the old full pull took about 12.5 seconds.
- When a full refresh is actually needed, run `markji_sync({ action: "start", mode: "pull", full: true })` explicitly. It is a background task: it returns a `task` first, then use `markji_sync({ action: "progress" })` to track progress.
- Writes only update the local cache and return immediately; network requests happen in sync tasks or auto sync.
- Auto sync runs after `idleQuietMs` (default 2 minutes) of quiet following the most recent tool call. When nothing is pending, it pulls every `autoPullMs` (default 15 minutes). After a failure it retries every `retryBackoffMs` (default 5 minutes).
- Open conflicts pause auto push, but pulls continue.
- Requests use a sliding-window rate limit (default 18 per 10 seconds, 36 per minute, 7,800 per 5 hours); concurrent syncs queue automatically.
- Card content is limited to 100,000 characters; `markji_cards` `list` accepts `limit` up to 200, `search` up to 100, and the new batch entries accept at most 50 items each (archive / move are not capped).

## Error codes and troubleshooting

Tool errors usually look like `markji: <code>: <message> (hint: ...)`; malformed arguments may produce a plain `markji_xxx: "field" ...` message without a code. Common codes:

| Code | Meaning and action |
| --- | --- |
| `not_configured` | No token is available. Set `MAIMEMO_MARKJI_OPENAPI_TOKEN`, fully quit DSH, and restart so the host process sees the new environment variable. |
| `unknown_deck` / `unknown_chapter` / `unknown_card` / `unknown_folder` | The id is not in the local cache. The fallback refresh already ran; if the object was created on another device, run `markji_sync({ action: "start", mode: "pull", full: true })` and retry. |
| `invalid_argument` | Missing or wrongly typed argument, bad time format, incomplete `chapter_ids`, empty content, content over 100,000 characters, etc. Fix the arguments according to the message. |
| `invalid_content` | Invalid card content (for example, empty after normalization). |
| `invalid_card_content` | The card body failed raw Markji syntax validation. Use `markji_cards({ action: "validate" })` to see line / column and error codes, fix the content, then push again. |
| `media_unavailable` | An image / mask / audio file id in the body cannot be found in Markji. Upload it with `markji_file`, then update the body with the returned `file.id`. |
| `media_check_failed` | The pre-push media query failed (network, auth, etc.). The card stays queued; retry `markji_sync` after recovery. |
| `conflict_open` | The card has an open conflict. Resolve it with `markji_sync({ action: "resolve" })` first. |
| `unknown_conflict` | The conflict id does not exist or was already resolved. Fetch the current list with `markji_sync({ action: "failures" })`. |
| `unknown_task` / `task_not_resumable` | The `resume` task id does not exist, or the task is not `interrupted` / has already finished. Check with `markji_sync({ action: "progress" })`. |
| `deck_mismatch` | The target chapter or card does not belong to the specified deck. Check that the ids match the `deck` argument. |
| `cache_busy` | Another DSH process holds `cache.write.lock`. Wait for it to finish and retry; do not delete the lock of a live process manually. |
| `engine_unavailable` | The plugin engine did not load completely. Disable and re-enable the plugin, or restart DSH. |
| `conflict_resolve_failed` | Writing failed while resolving a conflict; see the message. Usually retry or use `keep_remote`. |
| `bad_response` | Markji returned data that could not be parsed. Retry; if it persists, check `baseUrl` and the network. |
| `common_*` | Markji server error codes (for example `common_unauthorized`, `common_invalid_res_id`, `common_revision_mismatch`); use the server's code and message. |
| `ENOENT` | The local path passed to `markji_file` does not exist. |

Common issues:

- **`configured: false` in `markji_sync({ action: "state" })`**: the DSH host process did not see the token. On Windows you must restart DSH after `setx`; on WSL / Linux, `export` it in the same shell that starts DSH, then restart DSH.
- **401 / 403**: the token is invalid, expired, or lacks OpenAPI permission; generate a new one on the platform. Do not put the token in `cordis.patch.yml` or commit it to the repository.
- **The first call is slow**: the first call pulls all decks, chapters, and cards; thousands of cards usually take tens of seconds to a few minutes, which is expected. Watch the background task with `markji_sync({ action: "progress" })` instead of starting duplicate syncs.
- **A card just created on the phone or web is missing locally**: the fallback refresh pulls only changed decks. If the deck's `updated_time` did not change, run `markji_sync({ action: "start", mode: "pull", full: true })`.
- **Auto sync is not pushing**: first check `markji_sync({ action: "failures" })` for open conflicts; auto push pauses while any are open. After resolving them, run `markji_sync({ action: "start", mode: "push" })`.
- **`cache_busy` keeps appearing**: check whether another DSH process is using the same `dataDir`; close the extra process. Locks left by a crashed process are reclaimed after checking the owner pid / hostname.
- **The cache is corrupted**: the plugin renames the old database to a backup, rebuilds it, and pulls again. Check the DSH logs and `markji_sync({ action: "state" }).last_error`.
- **Using it under WSL**: DSH itself must run inside that WSL distribution's Linux environment; export the token in the shell that starts DSH. Keep the SQLite cache on the Linux filesystem (for example `~/.dsh/...`), not under `/mnt/c`, to avoid file-lock and performance problems.

## Data and privacy

- The cache is `<dataDir>/cache.db` (default `~/.dsh/dsh-markji-bridge`) and stays on the local machine; nothing is sent anywhere except the Markji API.
- The plugin never writes the token to the cache or logs; tokens found in logs are replaced with `<redacted>`.
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
| Windows + Node 25.2.1 | 2.2.0: unit 106/106, E2E 13/13, entry smoke 4 tools. Real-account testing of sync, file / image upload, archive, remote-deletion conflict, chapter-deletion conflict, and crash resume was done on 1.x; the 2.1.0 DSH background-job integration and 2.2.0 fuzzy / regex search were also exercised in a live DSH. |
| WSL2 Ubuntu 26.04 (Linux 6.18, Node v22.22.1) | Last verified on 1.6.0: unit 97/97, E2E 13/13, entry smoke 19 tools; 2.0.0 has not been re-run in WSL. |
| macOS | Not tested on real hardware; the code uses only Node built-in modules and should work. |

The WSL verification ran the repository's tests and entry smoke check directly in Linux; it did not install a second DSH inside WSL. To actually use the plugin under WSL, DSH itself should also run in that distribution.

2.0.0 consolidates the 19 fine-grained tools into four action-based tools and adds deck detail, chapter detail, and `with_cards`; chapter create / rename / sort reuse the existing engine. 2.1.0 connects sync tasks to DSH's native background-job mechanism instead of sending a plugin-specific completion message. 2.2.0 adds `fuzzy` approximate matching and `regex` regular-expression queries to card search while keeping the default `substring` behavior. These paths are covered by local unit tests, the entry smoke test, and the mock HTTP end-to-end test. Real-account checks in the table above were performed before these changes; this release did not repeat a real-account media query.

## Development and testing

Node >= 22.13 is required. Run from the repository source:

```bash
node --test "test/*.test.js"   # unit / integration tests (106)
node test/e2e-mock.mjs         # mock-server end-to-end (13)
node test/index-smoke.mjs      # entry smoke test (4 tools)
```

There is also an internal independent verification suite used for pre-release cross-checking; it is not published in the repository. The public repository contains only the tests listed above.

Tests must run from the repository source. Main files: `index.js` (entry and configuration), `lib/api.js` (HTTP client), `lib/store.js` (cache and write locks), `lib/sync.js` (sync engine), `lib/search.js` (substring / fuzzy / regex matching), `lib/jobs.js` (DSH background-job bridge), `lib/plain-text.js` (plain-text conversion), `lib/card-syntax.js` (raw syntax validation), and `lib/tools.js` (tool definitions). The module contract is [DESIGN.md](./DESIGN.md).

## License

MIT, see [LICENSE](./LICENSE).
