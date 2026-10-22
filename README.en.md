[中文](README.md) | **English**

# dsh-markji-bridge

A Markji (maimemo) flashcard plugin for DeepSeek Harness (DSH) agents. It maintains a local cache of decks, chapters, and cards, so an agent can search, read, create, update, and archive cards. Every edit is written to a local queue first, then synced to the cloud in a pull → three-way merge → push order. Conflicts are reported separately and never block the rest of the cards.

18 `markji_*` tools, implemented with Node.js built-in modules only, with no third-party dependencies. New: a complete card-syntax assistant and an interactive editor — write a card top-to-bottom, select text and style it, build masks, and upload images / audio.

## Features

- **Local cache**: one SQLite file, `cache.db`, stores indexes, card bodies, the pending queue, conflicts, and sync tasks. Routine searches and reads do not call the API.
- **Plain-text search**: each card also stores a plain-text column with formatting markers, image/audio markers, data URIs, and base64 removed. Search matches the plain text only, so results stay clean and readable.
- **Safe writes**: edits are queued; before pushing, remote changes are pulled and three-way merged, so stale data never overwrites the cloud. Conflicts are deduplicated per card and can be resolved individually.
- **Background sync**: a sync task returns a handle immediately and exposes progress. After a crash or plugin restart, resume with the same handle without creating duplicate cloud objects.
- **Archive**: move cards into the same deck's "Archive" chapter and insert an archive note into the body. Repeated calls are idempotent.
- **Multi-process safety**: multiple DSH processes on one machine can share a cache directory; writes are serialized with a file lock.
- **Card-syntax assistant**: markji_card_syntax provides a machine-readable syntax guide, simple front/back compilation, structured spec compilation, content validation and bracket escaping, covering headings, bold / underline / italic / strike / sup / sub / color / background, links, clozes, formulas and formula clozes, choices, ordered lists, images and masks, audio, card references and multi-page cards.
- **Interactive editor**: markji_card_editor writes cards through new -> type -> answer_line -> type -> format/cloze -> preview -> save without memorizing tags such as [T#B#...]; image can generate and upload a .msk1 mask from pixel rectangles.

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
markji_decks({ refresh: true })
markji_search({ query: "sorting", deck: "Algorithms" })
markji_card_get({ card: "<card_id>" })
markji_card_create({ deck: "<deck_id>", chapter: "<chapter_id>", front: "Question?", back: "Answer." })
markji_card_editor({ action: "new", deck: "<deck_id>", chapter: "<chapter_id>" })
markji_card_editor({ action: "type", draft: "<draft_id>", text: "Question?" })
markji_card_editor({ action: "answer_line", draft: "<draft_id>" })
markji_card_editor({ action: "type", draft: "<draft_id>", text: "Answer." })
markji_card_editor({ action: "preview", draft: "<draft_id>" })
markji_card_editor({ action: "save", draft: "<draft_id>" })
markji_sync({ mode: "auto" })
```

The first call pulls cloud data (it can take a while for large accounts); later reads use the local cache. Use `markji_status` / `markji_sync_status` to inspect state and progress.

## Tools

| Tool | Purpose |
| --- | --- |
| `markji_decks` | List decks and folders |
| `markji_chapters` | List the chapters of a deck |
| `markji_cards` | Paginate / search cached cards |
| `markji_search` | Find cards by deck name, chapter name, plain text, and update time |
| `markji_card_get` | Read one card: `content` (rich text) + `text` (plain text) |
| `markji_card_syntax` | Syntax guide / simple front-back compilation / validation / spec compilation / bracket escaping |
| `markji_card_create` | Create a card from raw syntax, spec, or front/back |
| `markji_card_update` | Update a card from raw syntax, spec, or front/back |
| `markji_card_editor` | Interactive writing: type, select, format, cloze, images / masks, audio, preview, save |
| `markji_card_archive` | Archive cards into the "Archive" chapter |
| `markji_cards_move` | Move cards to another chapter |
| `markji_chapters_edit` | Create / rename / sort chapters |
| `markji_sync` | Start background sync (pull / push / auto; resumable) |
| `markji_sync_status` | View sync task progress and history |
| `markji_failures` | View failed cards, conflicts, and recovery advice |
| `markji_status` | Plugin and cache overview |
| `markji_conflict_resolve` | Resolve a conflict (keep_local / keep_remote / use_content) |
| `markji_file` | Upload a file to Markji or query file metadata |

## Tool parameters and return values

`?` marks an optional parameter. All ids are Markji OpenAPI ids; objects that have not been pushed yet use `local_*` ids. Tool results are JSON and are truncated when they exceed `maxOutputChars`.

| Tool | Parameters | Returns (main fields) |
| --- | --- | --- |
| `markji_decks` | `refresh?` `folder_id?` | `{folders, decks, total, cache}` |
| `markji_chapters` | `deck?` `refresh?` | With `deck`: `{deck_id, deck_name, chapters, cache}`; without: `{decks, cache}` |
| `markji_cards` | `deck?` `chapter?` `query?` `limit?` `offset?` | `{total, offset, limit, has_more, cards, cache}` |
| `markji_search` | `query?` `deck?` `deck_name?` `chapter?` `chapter_name?` `updated_after?` `updated_before?` `limit?` `offset?` `refresh?` | `{total, offset, limit, has_more, filters, cards, cache}` |
| `markji_card_get` | `card` `deck?` | `{card}` |
| `markji_card_syntax` | `action: guide/simple/validate/compile/escape`; `content?` `front?` `back?` `title?` `spec?` `text?` | guide: `{ok, guide}`; simple: `{ok, content, warnings, stats, text}`; validate: `{ok, errors, warnings, stats, text}`; compile: `{ok, content, warnings, stats, text}`; escape: `{ok, escaped}` |
| `markji_card_create` | `deck` `chapter`, plus one of `content` / `spec` / `front` (+ `back?` `title?`); `order?` `grammar_version?` | `{ok, card_id, deck_id, chapter_id, status, changed, pending, message}` |
| `markji_card_update` | `card`, plus one of `content` / `spec` / `front` (+ `back?` `title?`); `grammar_version?` | `{ok, card_id, status, changed, pending, message}` |
| `markji_card_editor` | `action` + `draft?` `deck?` `chapter?` `title?` `text?` `target?` `occurrence?` `style?` `color?` `background?` `url?` `group?` `file?` `path?` `mask?` `mask_path?` `mask_rects?` `width?` `height?` `label?` `play?` `latex?` `parts?` `inline?` `options?` `correct?` `fixed?` `items?` `ids?` `subtitle?` | write actions: `{ok, action, draft_id, block_count, can_undo, text, ...}`; preview: `{ok, content, text, warnings, stats}`; save: `{ok, card_id, content, ...}` |
| `markji_card_archive` | `cards` (non-empty array) | `{ok, archived, content_updated, already_archived, moved, chapters, status, pending, message}` |
| `markji_cards_move` | `cards` `to_chapter` `deck?` `order?` | `{ok, moved, to_chapter_id, status, pending, message}` |
| `markji_chapters_edit` | `action: create/rename/sort`; create: `deck` `name` `order?`; rename: `chapter` `name` `deck?`; sort: `deck` `chapter_ids` | `{ok, action, chapter_id?, deck_id?, chapters?, status, pending, message}` |
| `markji_sync` | `mode?: auto/pull/push` `full?` `resume?` | `{task, already_running?}` |
| `markji_sync_status` | `task_id?` | `{active, tasks}` |
| `markji_failures` | `card?` `deck?` `limit?` | `{ok, summary, conflicts, failed_cards, last_task_errors, recovery, truncated}` |
| `markji_status` | none | `{version, data_dir, cache_file, configured, base_url, cache, pending, conflicts, last_sync, last_error, active_task, tasks, auto_sync}` |
| `markji_conflict_resolve` | `id` `strategy: keep_local/keep_remote/use_content` `content?` | `{ok, id, entity, strategy, state, changed}` |
| `markji_file` | `action: upload/query`; upload: `path` `deck?`; query: `ids` `expires?` | upload: `{file}`; query: `{files}` |

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

For `markji_card_archive`, `chapters` is `[{ deck_id, chapter_id, chapter_name, local }]`. For `markji_file`, `file` is returned by Markji; common fields are `id`, `url`, `mime`, `size`, `info`, and `expire_time`.

## Card syntax and the interactive editor

### Four ways to write a card

1. **Simplest front/back**: pass front (question) and optional back (answer) / title (heading) straight to markji_card_create. Plain text only; the compiler and validator escape text and split pages. This covers most ordinary Q&A cards.
2. **Interactive editor** (best when the agent writes while thinking): markji_card_editor treats a card as a draft, appends content top-to-bottom, then styles a literal text selection. It does not require assembling Markji syntax first; preview shows the final content and save queues it.
3. **Structured spec** (best when generating a whole card at once): pass pages: [[block...], [block...]] to markji_card_syntax({ action: "compile", spec }) or directly as markji_card_create spec.
4. **Raw syntax**: write content directly, check it with markji_card_syntax({ action: "validate", content }), then create or update.

The complete machine-readable grammar, spec schema, examples and hard rules:

~~~text
markji_card_syntax({ action: "guide" })
~~~

Simplest call (no Markji syntax at all):

~~~text
markji_card_create({ deck: "<deck_id>", chapter: "<chapter_id>", front: "Question?", back: "Answer." })
markji_card_syntax({ action: "simple", front: "Question?", back: "Answer." })
~~~

### Interactive editor: write like typing

~~~text
markji_card_editor({ action: "new", deck: "<deck_id>", chapter: "<chapter_id>", title: "Photosynthesis" })
markji_card_editor({ action: "type", draft: "<draft_id>", text: "Where does photosynthesis mainly happen?" })
markji_card_editor({ action: "answer_line", draft: "<draft_id>" })
markji_card_editor({ action: "type", draft: "<draft_id>", text: "In chloroplasts. It is a structure in plant cells." })
markji_card_editor({ action: "format", draft: "<draft_id>", target: "chloroplasts", style: "bold" })
markji_card_editor({ action: "cloze", draft: "<draft_id>", target: "plant cells", group: 1 })
markji_card_editor({ action: "preview", draft: "<draft_id>" })
markji_card_editor({ action: "save", draft: "<draft_id>" })
~~~

Editing rules:

- In type, a real newline starts a new paragraph and a line containing only --- starts a new page. Literal [ and ] are escaped automatically.
- format target is literal text and must sit inside one paragraph; use occurrence when it repeats. Styles: bold underline italic strike sup sub color background link clear.
- A normal cloze cannot contain styles. Clear them first with format style=clear, or put the style around the cloze. Omitted group uses the next number.
- heading creates [P#H1,center#...]; paragraph is a normal paragraph; answer_line only adds a page break.
- preview does not write the cloud; save creates the card through the normal local queue. Drafts live in plugin memory and are lost when the DSH host restarts, so save important work first.
- undo reverts one edit, discard deletes the draft, status shows the current plain text and blocks.

### Images, masks, audio

~~~text
markji_card_editor({ action: "image", draft: "<draft_id>", path: "C:/img/diagram.png",
  mask_rects: [{ x1: 100, y1: 200, x2: 400, y2: 300 }] })
markji_card_editor({ action: "audio", draft: "<draft_id>", path: "C:/audio/word.mp3", label: "Play", play: "auto" })
~~~

- image path is the local original image; mask_rects are rectangles in **original-image pixels**. The plugin reads the image size (PNG / JPEG / GIF / WebP), builds and uploads a .msk1 mask. You can also pass mask (an existing file.id) or mask_path (a local .msk1).
- Pass multiple rectangles for multiple mask areas. Coordinates outside the image are rejected.
- audio play: auto (default, A), manual (M), default (D, follow the setting). A / M are mutually exclusive; D combines with either.
- Upload is the only network operation in the editor; the image and mask receive real Markji file.id values before they are embedded in the card.

### Formulas, formula clozes, choices, lists, card references

~~~text
markji_card_editor({ action: "formula", draft: "<draft_id>", latex: "E_k=\\frac{1}{2}mv^2" })
markji_card_editor({ action: "formula", draft: "<draft_id>",
  parts: ["k=", { cloze: "\\frac{\\Delta y}{\\Delta x}", group: 1 }] })
markji_card_editor({ action: "choice", draft: "<draft_id>", options: ["A", "B", "C"], correct: [2, 3], fixed: true })
markji_card_editor({ action: "list", draft: "<draft_id>", items: ["first", { text: "second", level: 2 }] })
markji_card_editor({ action: "card_ref", draft: "<draft_id>", ids: ["<root_id>"], label: "See also" })
~~~

- Write only the LaTeX body; do **not** wrap it in $, $$, \(...\) or \[...\].
- In parts, strings are formula fragments and { cloze, group } is a formula cloze; the whole formula becomes one [E##...].
- choice correct uses **1-based** indices, or option objects { text, correct: true }. Multiple correct options automatically use multi.
- list creates [P#L#...]; level 1 can be omitted, level: 2 creates [P#L,I2#...].
- card_ref ids are Markji root_ids (at most 5); label is the anchor text.

### Raw-syntax hard rules

| Rule | Description |
| --- | --- |
| Pages | A line containing only --- separates question / answer / reveal pages; without it the card has one page. |
| Tag shape | General form [name#params#content]; both # are always required. |
| Block tags | [P#...], [Choice#...], [Pic#...], a standalone [E##...] and --- must start at column 1 with no leading spaces. |
| Text styles | [T#styles#text]; combine with commas, e.g. [T#B,U,I,!ff2600,!!fff3b0,link/"https://..."#text]. |
| Cloze | [F#positive-integer#hidden text]; do not nest styles inside a normal cloze. |
| Formulas | [E##LaTeX]; a formula cloze is [E##prefix[F#1#LaTeX]suffix]. |
| Images / masks | [Pic#ID/<fileId>#]; with a mask [Pic#ID/<imageId>,MID/<maskId>#], content empty. |
| Audio | [Audio#A|M|D,ID/<fileId>#label]; A auto, M manual, D follow the setting; A / M are exclusive. |
| Card references | [Card#ID/<root_id>#label]; join multiple root_ids with -, at most 5. |
| Choices | [Choice##...] single, [Choice#multi#...] multi; * marks a correct option and - an incorrect one; the closing ] is on its own line; fixed is optional. |
| Escaping | Write literal brackets as \[ and \], otherwise they are parsed as tags. |
| Nesting | P may contain T / F / Audio / Card; Choice options may contain T / E; E may contain F; other nesting is unsupported. |

Do not hand-write tags from memory. Use markji_card_syntax validate when unsure, or use the editor / spec.

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
- Conflicts do not block other cards. Resolve them with `keep_local` (keep the local edit and overwrite the cloud on the next push), `keep_remote` (accept the cloud version and discard the local edit), or `use_content` (replace the local pending content with the supplied content).
- Sync tasks record progress and results, keeping the latest 20. If the process is interrupted, the task is marked `interrupted`; resume it with `markji_sync resume=<task_id>`.
- Inspect failures or conflicts with `markji_failures`, then run `markji_sync mode=push`.

## Performance and behavior

- Reads prefer the local cache. When the cache is older than `pullTtlMs` (default 10 minutes) or `refresh: true` is passed, an incremental pull runs first.
- Since 1.0.1, the fallback refresh for an unknown id pulls only decks marked as changed in the cloud, instead of pulling every deck. On a measured account with 5,265 cards / 82 chapters, renaming an unknown chapter returned `unknown_chapter` in about 0.8 seconds and an unknown card in about 0.3 seconds; the old full pull took about 12.5 seconds.
- When a full refresh is actually needed, run `markji_sync({ mode: "pull", full: true })` explicitly. It is a background task: it returns a `task` first, then use `markji_sync_status` to track progress.
- Writes only update the local cache and return immediately; network requests happen in sync tasks or auto sync.
- Auto sync runs after `idleQuietMs` (default 2 minutes) of quiet following the most recent tool call. When nothing is pending, it pulls every `autoPullMs` (default 15 minutes). After a failure it retries every `retryBackoffMs` (default 5 minutes).
- Open conflicts pause auto push, but pulls continue.
- Requests use a sliding-window rate limit (default 18 per 10 seconds, 36 per minute, 7,800 per 5 hours); concurrent syncs queue automatically.
- Card content is limited to 100,000 characters; `markji_cards` accepts `limit` up to 200 and `markji_search` up to 100.

## Error codes and troubleshooting

Tool errors usually look like `markji: <code>: <message> (hint: ...)`; malformed arguments may produce a plain `markji_xxx: "field" ...` message without a code. Common codes:

| Code | Meaning and action |
| --- | --- |
| `not_configured` | No token is available. Set `MAIMEMO_MARKJI_OPENAPI_TOKEN`, fully quit DSH, and restart so the host process sees the new environment variable. |
| `unknown_deck` / `unknown_chapter` / `unknown_card` / `unknown_folder` | The id is not in the local cache. The fallback refresh already ran; if the object was created on another device, run `markji_sync({ mode: "pull", full: true })` and retry. |
| `invalid_argument` | Missing or wrongly typed argument, bad time format, incomplete `chapter_ids`, empty content, content over 100,000 characters, etc. Fix the arguments according to the message. |
| `invalid_content` | Invalid card content (for example, empty after normalization). |
| `conflict_open` | The card has an open conflict. Resolve it with `markji_conflict_resolve` first. |
| `unknown_conflict` | The conflict id does not exist or was already resolved. Fetch the current list with `markji_failures`. |
| `unknown_task` / `task_not_resumable` | The `resume` task id does not exist, or the task is not `interrupted` / has already finished. Check with `markji_sync_status`. |
| `deck_mismatch` | The target chapter or card does not belong to the specified deck. Check that the ids match the `deck` argument. |
| `cache_busy` | Another DSH process holds `cache.write.lock`. Wait for it to finish and retry; do not delete the lock of a live process manually. |
| `engine_unavailable` | The plugin engine did not load completely. Disable and re-enable the plugin, or restart DSH. |
| `conflict_resolve_failed` | Writing failed while resolving a conflict; see the message. Usually retry or use `keep_remote`. |
| `bad_response` | Markji returned data that could not be parsed. Retry; if it persists, check `baseUrl` and the network. |
| `common_*` | Markji server error codes (for example `common_unauthorized`, `common_invalid_res_id`, `common_revision_mismatch`); use the server's code and message. |
| `ENOENT` | The local path passed to `markji_file` does not exist. |

Common issues:

- **`configured: false` in `markji_status`**: the DSH host process did not see the token. On Windows you must restart DSH after `setx`; on WSL / Linux, `export` it in the same shell that starts DSH, then restart DSH.
- **401 / 403**: the token is invalid, expired, or lacks OpenAPI permission; generate a new one on the platform. Do not put the token in `cordis.patch.yml` or commit it to the repository.
- **The first call is slow**: the first call pulls all decks, chapters, and cards; thousands of cards usually take tens of seconds to a few minutes, which is expected. Watch the background task with `markji_sync_status` instead of starting duplicate syncs.
- **A card just created on the phone or web is missing locally**: the fallback refresh pulls only changed decks. If the deck's `updated_time` did not change, run `markji_sync({ mode: "pull", full: true })`.
- **Auto sync is not pushing**: first check `markji_failures` for open conflicts; auto push pauses while any are open. After resolving them, run `markji_sync({ mode: "push" })`.
- **`cache_busy` keeps appearing**: check whether another DSH process is using the same `dataDir`; close the extra process. Locks left by a crashed process are reclaimed after checking the owner pid / hostname.
- **The cache is corrupted**: the plugin renames the old database to a backup, rebuilds it, and pulls again. Check the DSH logs and `markji_status.last_error`.
- **Using it under WSL**: DSH itself must run inside that WSL distribution's Linux environment; export the token in the shell that starts DSH. Keep the SQLite cache on the Linux filesystem (for example `~/.dsh/...`), not under `/mnt/c`, to avoid file-lock and performance problems.

## Data and privacy

- The cache is `<dataDir>/cache.db` (default `~/.dsh/dsh-markji-bridge`) and stays on the local machine; nothing is sent anywhere except the Markji API.
- The plugin never writes the token to the cache or logs; tokens found in logs are replaced with `<redacted>`.
- Multiple DSH processes can share the cache directory; writes are serialized with `cache.write.lock`. Sharing across machines is not recommended.
- If the cache is corrupted, it is renamed to a backup and pulled again.

## Known limitations

- The Markji OpenAPI cannot create or delete decks, or delete cards; those operations still need the web app or client.
- Only one Markji account is supported.
- Conflicts must be resolved manually; auto push pauses while any are open.
- `grammarVersion` is a global default, used when a card's own version is unknown.
- Editor drafts live only in plugin memory and are lost after a DSH host restart or plugin reload; save first.
- The editor styles a **plain-text selection**; it does not support selections across paragraphs or inserting in the middle of a draft. Use spec / raw syntax for finer layout.

## Platform verification

| Environment | Result |
| --- | --- |
| Windows + Node 24.21.0 | Real-account testing: sync, file / image upload, archive, remote-deletion conflict, chapter-deletion conflict, crash resume; mask generation is covered by unit tests; unit 88/88, independent verification 138/138 (internal suite), E2E 13/13, smoke 18 tools. |
| WSL2 Ubuntu 26.04 (Linux 6.18, Node v22.22.1) | Repository copied to the Linux filesystem (`/tmp`): unit 88/88, independent verification 138/138 (internal suite), E2E 13/13, entry smoke 18 tools. |
| macOS | Not tested on real hardware; the code uses only Node built-in modules and should work. |

The WSL verification ran the repository's tests and entry smoke check directly in Linux; it did not install a second DSH inside WSL. To actually use the plugin under WSL, DSH itself should also run in that distribution.

## Development and testing

Node >= 22.13 is required. Run from the repository source:

```bash
node --test "test/*.test.js"   # unit / integration tests (88)
node test/e2e-mock.mjs         # mock-server end-to-end (13)
node test/index-smoke.mjs      # entry smoke test (18 tools)
```

There is also an internal independent verification suite (138 checks) used for pre-release cross-checking; it is not published in the repository. The public repository contains only the tests listed above.

Tests must run from the repository source. Main files: `index.js` (entry and configuration), `lib/api.js` (HTTP client), `lib/store.js` (cache and write locks), `lib/sync.js` (sync engine), `lib/plain-text.js` (plain-text conversion), and `lib/tools.js` (tool definitions).

## License

MIT, see [LICENSE](./LICENSE).
