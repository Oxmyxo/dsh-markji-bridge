# dsh-markji-bridge — design and module contract

DSH persistent Host plugin (profile-global) that gives the agent tools to manage the
user's Markji (墨墨记忆卡) cards. It keeps a local card cache, applies edits locally,
and syncs them to the cloud when idle or on demand. Before pushing, it pulls remote
changes that were not cached yet, merges them (3-way), records conflicts without
aborting other cards, then pushes local edits.

Status: implementation contract. Every module must match the signatures below exactly.
The package directory is installed with plugin_manager action=install_bundle. Package and
bundle name: dsh-markji-bridge; the 17 agent tool names are markji_*.

## Environment facts (verified 2026-10-22)

- Host runtime: Node 24.21.0 (Electron 44.7.0); global fetch, FormData, Blob available.
- Only Node builtins may be imported. No npm dependencies, no TypeScript, ESM (type: module).
- Tests run with system Node: `node --test` from the package dir (Node v25.2.1 available; `node --test test/` is not a valid directory form).
- Plugin data dir default: <homedir>/.dsh/dsh-markji-bridge ; config dataDir overrides.
- Legacy data dir: on startup, when the default data dir has no cache.db yet, a cache
  written by an earlier local build into <homedir>/.dsh/markji-bridge (and its SQLite
  sidecars) is copied over; the legacy files are kept, never moved. The database is copied
  to a process-private temp name and renamed into place, so concurrent starter processes
  never read a half-copied file. Sidecars are copied after the database; a process kill in
  that short window leaves the legacy files intact and can be copied manually (migration
  is not retried once the target cache.db exists).
- Never run plugin_manager from a teammate; only the Lead installs/removes the bundle.

## Files and ownership (write scopes are exclusive)

File | Owner | Purpose
DESIGN.md | Lead | this contract
README.md | Lead | Chinese user doc + verification log
lib/rate-limit.js | api-client | token-window limiter
lib/api.js | api-client | Markji HTTP client
test/api.test.js, test/rate-limit.test.js, test/live-read.mjs | api-client | tests
lib/plain-text.js | Lead | rich-text -> searchable plain text (memoized, versioned)
lib/card-syntax.js | tools-layer | raw Markji syntax validator (no compiler or editor)
test/card-syntax.test.js | tools-layer | raw syntax validation and media extraction tests
lib/store.js | cache-sync | cache persistence (schema v4: cards.text)
lib/sync.js | cache-sync | pull/merge/push engine, unified list filters/views
lib/search.js | cache-sync | substring / fuzzy / regex query matcher (pure, no cache access)
lib/predicate.js | cache-sync | safe JSON predicate compiler (conditions, all/any/not, field allow-list)
lib/jobs.js | cache-sync | bridge a sync task to a DSH background job (progress, settle, cancel)
test/sync-task.test.js, test/jobs.test.js, test/search.test.js, test/predicate.test.js, test/list-filter.test.js, test/tool-search.test.js, test/verify/*.test.js | cache-sync / tools-layer / verifier | task, job bridge, filters + store/merge/push tests
index.js, lib/tools.js, package.json, cordis.patch.yml, locale/*.json, icon.svg | tools-layer | entry + tools + manifest
test/e2e-mock.mjs, test/mock-server.mjs | Lead | HTTP mock end-to-end
test/verify/** | verifier | independent checks

## Markji OpenAPI facts (verified live with the provided token)

Base URL https://open.maimemo.com/open ; every path starts with /api/v1 .
Auth header: Authorization: Bearer <token> and Accept: application/json .
Test server https://open-dev.maimemo.com/open rejects this token (401) — do not use it.

Every response is wrapped:

    { "errors": [], "success": true, "data": { ... } }
    { "errors": [{ "code": "common_invalid_res_id", "msg": "Invalid resource id", "info": "id: xxx" }], "success": false }

Unwrap data; a non-2xx status or success !== true throws MarkjiError.
429 replies include x-ratelimit-* headers and may carry Retry-After.

Rate limits (doc + live headers): 20 requests / 10 s (x-ratelimit-limit-short), 40 / 60 s
(-medium), 8000 / 5 h (-long, Markji scope). Enforce all three client-side.
Daily content-creation cap 600 for the whole account; never batch creation aggressively.

Endpoints used (all under /api/v1, path ids URL-encoded):

Method | Path | Body / query | data
GET | /markji/decks/folders | — | { folders: [{id, items:[{object_id,object_class,order?}], parent_id?, name}] }
GET | /markji/decks | offset,limit,folder_id | { decks:[deck], total }
GET | /markji/decks/{deck} | with_root | { deck }
GET | /markji/decks/{deck}/chapters | with_cards, updated_time | { chapterset, chapters?, cards? }
GET | /markji/decks/{deck}/chapters/{chapter} | with_cards | { chapterset?, chapter?, cards? }
POST | /markji/decks/{deck}/chapters | {name,order?} | { chapter, chapterset }
POST | /markji/decks/{deck}/chapters/{chapter} | {name,revision?} | { chapter }
POST | /markji/decks/{deck}/chapters/sort | {chapter_ids,revision} | { chapterset }
GET | /markji/decks/{deck}/cards/{card} | — | { card }
POST | /markji/decks/{deck}/chapters/{chapter}/cards | {card:{content,grammar_version},order?} | { card, chapter }
POST | /markji/decks/{deck_id}/cards/{card_id} | {card:{content,grammar_version}} | { card }
POST | /markji/decks/{deck}/chapters/{chapter}/cards/move | {card_ids,to_chapter_id,order?} | { new_chapter, old_chapter }
POST | /markji/files | multipart/form-data, field "file", optional deck_id | { file }
POST | /markji/files/query | {ids:[],expires?} | { files }

Live payload notes (differ from the YAML doc, follow the live data):

- card.content_type is the integer 1 (doc claims string PLAIN); keep it opaque.
- card.grammar_version observed 3; config default 3. Updates MUST reuse the card's
  existing grammar_version when known, else config default.
- card objects carry no chapter_id; derive it from chapter.card_ids.
- folder.items[] may omit order.
- updated_time is ISO-8601 UTC; revision is a monotonically increasing integer.
- Bad/unknown id -> HTTP 400 common_invalid_res_id; auth failure -> 401 common_unauthorized.
- No Markji delete endpoint exists for decks, chapters or cards: never invent one.
- Write bodies must NOT repeat the path ids (verified live 2026-10-22): with real path ids and
  an empty JSON body the only reported missing properties are name / chapter_ids / card /
  card_ids — never deck/chapter/deck_id/card_id. The server parses body id fields as Mongo
  ObjectId, so repeating "mkjd_…"/"mkjch_…" there fails with
  common_invalid_param "<id> not a valid ObjectId". Body-only ids (card_ids, to_chapter_id,
  files/query ids, the multipart deck_id field) accept the OpenAPI ids unchanged; a same-chapter
  move with {card_ids,to_chapter_id} returns 201.
- More live validation facts (2026-10-22, real token, no content changed):
  card create/update require a non-empty card.content ("card must have required property
  'content'"); chapter create/rename reject names longer than 48 chars ("name exceed max
  length 48"); sortChapters does NOT validate the revision — a stale revision is accepted and
  the provider writes the order (observed chapterset revision 1 -> 2 with unchanged order), so
  the plugin must keep sending the cached revision and reconcile on the next pull; a
  same-chapter move succeeds with 201 and leaves the chapter/card content untouched.

## Config (row config in cordis.patch.yml, normalized by index.js)

key | default | meaning
enabled | true | false registers nothing
apiKey | '' | optional Bearer token override; fallback env MAIMEMO_MARKJI_OPENAPI_TOKEN (legacy MAIMEMO_OPENAPI_TOKEN); empty -> tools report not configured
baseUrl | https://open.maimemo.com/open | no trailing slash
dataDir | '' | cache directory; empty -> <homedir>/.dsh/dsh-markji-bridge
grammarVersion | 3 | default for new cards
requestTimeoutMs | 20000 | per HTTP attempt
maxRetries | 3 | retries for network/429/5xx
pageSize | 100 | deck list page size
pullTtlMs | 600000 | read-triggered lazy pull freshness
autoSync | true | idle auto push/pull
idleCheckMs | 30000 | auto-sync tick period
idleQuietMs | 120000 | quiet time since last markji tool activity before auto work
autoPullMs | 900000 | background pull cadence when idle and nothing pending
retryBackoffMs | 300000 | min delay before auto retry after a failed auto sync
maxOutputChars | 20000 | tool text render cap

Normalized object passed to createClient / createStore / createEngine / registerTools is
exactly this camelCase shape. Invalid numbers are clamped, unknown keys ignored.

## lib/rate-limit.js

    export const DEFAULT_LIMITS = [
      { windowMs: 10000, max: 18 },      // provider 20/10s, keep headroom
      { windowMs: 60000, max: 36 },      // provider 40/60s
      { windowMs: 18000000, max: 7800 }, // provider 8000/5h
    ];
    export function createLimiter(options = {})
    // options: { limits?, now?, sleep?, log? }
    // returns: {
    //   acquire(): Promise<void>   // resolves when one request may start; records the timestamp
    //   snapshot(): { used: number[], limits, waitMs }
    //   reset(): void
    // }

Sliding-window per limit (timestamps array per window; prune older than windowMs at each
acquire). acquire() must be concurrency-safe (one timer at a time, FIFO waiters).
snapshot().waitMs = estimated wait before the next acquire can start.

## lib/api.js

    export class MarkjiError extends Error {
      constructor({ code, status, message, details, retriable })
      // fields: code, status, retriable, details
    }

    export function createClient({ apiKey, baseUrl, timeoutMs, maxRetries, limiter, fetchImpl, log })
    // fetchImpl defaults to globalThis.fetch; log(level, message) optional.
    // returns {
    //   configured: boolean,
    //   listFolders(): Promise<folder[]>,
    //   listDecksPage({ offset, limit, folder_id }): Promise<{ decks, total }>,
    //   listAllDecks({ pageSize }): Promise<deck[]>,   // follows total, hard guard 100 pages
    //   getDeck(deck, { with_root } = {}): Promise<deck>,
    //   listChapters(deck, { with_cards, updated_time } = {}): Promise<{ chapterset?, chapters, cards }>,
    //   getChapter(deck, chapter, { with_cards } = {}): Promise<{ chapterset?, chapter, cards }>,
    //   createChapter({ deck, name, order }): Promise<{ chapter, chapterset }>,
    //   updateChapter({ deck, chapter, name, revision }): Promise<chapter>,
    //   sortChapters({ deck, chapter_ids, revision }): Promise<chapterset>,
    //   getCard(deck, card): Promise<card>,
    //   createCard({ deck, chapter, card: { content, grammar_version }, order }): Promise<{ card, chapter }>,
    //   updateCard({ deck_id, card_id, card: { content, grammar_version } }): Promise<card>,
    //   moveCards({ deck, chapter, card_ids, to_chapter_id, order }): Promise<{ new_chapter, old_chapter }>,
    //   uploadFile({ path, deck_id } | { data: Uint8Array, filename, mime, deck_id }): Promise<file>,
    //   queryFiles({ ids, expires }): Promise<file[]>,
    //   stats(): { requests, retries, lastStatus, lastErrorAt }
    // }

Behavior:

- fetchImpl(url, init) is injectable; JSON requests send content-type application/json.
- Every attempt: await limiter.acquire(); AbortSignal.timeout(timeoutMs); parse JSON; unwrap envelope.
- Retry network errors, timeouts, 429, 408, 5xx, up to maxRetries with exponential backoff
  500ms*2^n plus jitter, honoring Retry-After (seconds) when present. Other 4xx: throw immediately.
- Non-JSON / missing data -> MarkjiError code bad_response, retriable false, body snippet in details.
- Empty/absent apiKey -> configured false; every method throws MarkjiError code not_configured.
- uploadFile: read file with node:fs/promises; infer mime from extension (png/jpg/jpeg/gif/webp/
  mp3/wav/ogg/m4a/mp4/svg) else application/octet-stream; build FormData with
  new Blob([bytes], { type }), filename basename; append deck_id when given; do not set
  content-type manually.
- URL building: baseUrl + '/api/v1' + path; path segments via encodeURIComponent.
- postWrite(path, body, pathIds) sends the body with the path ids removed; only if the provider
  answers common_invalid_param "must have required property '<path id>'" does it retry once with
  the full body (compatibility fallback for the legacy contract).
- Do not mutate provider objects; return provider data as-is (store normalizes).

## lib/store.js

    export const CACHE_VERSION = 4;
    export function emptyCache(): Cache;
    export function createStore({ dataDir, log, clock = Date.now, saveDebounceMs = 400 })
    // returns {
    //   cache: Cache,                 // live object owned by the store (hydrated)
    //   path: string,                 // <dataDir>/cache.db
    //   load(): Promise<Cache>,       // idempotent; migrates cache.json / v2, recovers corrupt db
    //   flush(): Promise<void>,       // schedule debounced save
    //   saveNow(): Promise<void>,     // force save + await; coalesces concurrent calls
    //   stats(): { path, data_dir, bytes, db_bytes, content_bytes, content_files, decks,
    //              chapters, cards, conflicts, dirtyCards, loadedAt, savedAt, saveError },
    //   markDirty(),
    //   close(): Promise<void>,       // flush + close the SQLite handle (plugin teardown/tests)
    //   replace(next),
    //   withWriteLock(fn, { timeoutMs = 120000, onWait }): Promise<any>,
    //   refreshIfChanged(): Promise<boolean>,   // reload if another process wrote
    //   writeLocked: boolean,        // true while this process holds the writer lock
    //   lock_path: string,           // <dataDir>/cache.write.lock
    // }

Single SQLite file (index + card content; no cache.json and no per-card files):

- <dataDir>/cache.db is one SQLite database (node:sqlite DatabaseSync, builtin). SQL tables:
  meta / folders / decks / chapters / cards / moves / conflicts / tasks. Every record is stored
  as JSON in a data column except card content, which has dedicated columns on cards:
  content TEXT NOT NULL, text TEXT NOT NULL DEFAULT '' (derived plain text, see plain-text.js),
  base_content TEXT NULL, pending_content TEXT NULL, content_hash TEXT, content_bytes INTEGER.
  meta also carries plain_text_version (the algorithm version that produced cards.text).
- base_content is written only when cloud.content differs from content (pending/local edit);
  pending_content only while card.pending.content exists. When absent, load reconstructs
  cloud.content = content and pending.content = content.
- Save is diff-based inside one transaction: upsert only cards whose metadata or content
  signature changed (content_hash is SHA-256 of content/base/pending; unchanged signatures reuse
  the previous hash and never re-hash), delete rows that disappeared, upsert changed
  folders/decks/chapters/moves/conflicts/tasks/meta. If nothing changed the transaction is
  rolled back instead of committed. journal_mode=DELETE, synchronous=NORMAL; saves are
  serialized and debounced (saveDebounceMs); saveNow() coalesces. No WAL side files.
- Load: verify the 16-byte "SQLite format 3" header before opening (a non-SQLite file would keep
  a native handle locked on Windows); schema_version in meta selects the path:
  - 4: hydrate rows + content + text columns (already-current schema).
  - 3: add cards.text, backfill plainText(content) for every card, set schema_version=4; then, when
    meta.plain_text_version differs from PLAIN_TEXT_VERSION, recompute every cards.text row and
    update the marker (so an algorithm fix silently repairs the whole cache on next load).
  - missing cache.db + cache.json exists: one migration imports JSON (all rows, then renames the
    JSON to cache.imported-<iso>.json; log counts).
  - 2: migrate the old index+content-tree layout by reading cards/contents and content files,
    then rename cache.db -> cache.v2-backup-<iso>.db and content/ -> content.v2-backup-<iso>,
    and write the new single database.
  - corrupt / unknown -> keep cache.corrupt-<iso>.db (or cache.v<n>-backup-<iso>.db) and start
    from emptyCache() (no silent merge).
- In-memory Cache stays plain JSON and unchanged in shape (see schema below); sync.js/tools.js
  never see SQLite. markDirty() = schedule flush; every save updates stats. A cold load also
  restores stats from the file: db_bytes = stat.size, savedAt = mtimeMs, content_bytes = SUM of
  the persisted content_bytes column, so status is correct before the next save.

### Multi-process access

Several DSH host processes may open the same dataDir. Writers are serialized by a plain
lock file `<dataDir>/cache.write.lock` containing `{ pid, host, at, token }`:

- `withWriteLock` first waits for an in-process writer (AsyncLocalStorage owner token; only the
  owner may re-enter), then creates the lock file with O_EXCL, refreshing its mtime every 5 s.
  A lock is reclaimed when its pid is dead (same host), its host differs, or its mtime is older
  than 120 s. Timeout surfaces `cache_busy`.
- The owner calls `refreshIfChanged()` before mutating: compare the current cache.db size/mtime
  with the signature captured at the last own save; if another process wrote, flush own dirty
  state, then reload all rows in one transaction. This never reloads while another context in
  this process is mid-write (the lock owner is exempt).
- Every engine write method (createCard/updateCard/moveCards/archiveCards/editChapter/
  resolveConflict) and every sync/pull/push/task run is wrapped in `withWriteLock`; a started
  task that has to wait sets `stage=waiting_lock`. Read methods call `refreshIfChanged` only
  while idle (no active task, not syncing, writer not held).
- `openDb` sets `PRAGMA busy_timeout=5000` for the short window before the lock is taken.
  journal_mode stays DELETE; no WAL side files.
- Concurrency semantics: writers are serialized and re-read before writing, so two tool calls
  on the same card are last-lock-wins without lost-update conflicts. Network filesystems are
  not supported (their lock/atomicity semantics differ).

### Cache schema (exact keys; snake_case on disk)

    Cache = {
      version: 4,
      created_at: number,
      meta: {
        last_pull_at: number|null, last_full_pull_at: number|null, last_push_at: number|null,
        last_sync: SyncReport|null, last_error: string|null, conflict_seq: number,
      },
      folders: { [id]: { id, name, parent_id?, items: [{ object_id, object_class, order? }], pulled_at } },
      decks: { [id]: {
        id, name, description, revision, is_private, source, status,
        card_count, chapter_count, created_time, updated_time,
        chapterset_revision: number|null, chapter_ids: string[], pulled_at,
        missing?: true, pending_sort?: { chapter_ids: string[], base_revision: number } | null,
      } },
      chapters: { [id]: {
        id, deck_id, name, revision: number|null, updated_time, order: number, card_ids: string[],
        local?: true,                   // created locally, id local_ch<random>
        pending?: { op: 'create'|'rename', name: string, order?: number, base_revision?: number } | null,
        missing?: true, pulled_at,
      } },
      cards: { [id]: {
        id,                             // real id or local_cd<random>
        deck_id, chapter_id,            // chapter_id may reference a local chapter
        local?: true,                   // exists only locally until pushed
        content: string,                // effective local content (rich text)
        text?: string,                  // derived plain text; hydrated from cards.text, never stored in data JSON
        grammar_version: number,
        cloud: null | { revision, content, grammar_version, content_type, updated_time, chapter_id, status },
        pending: null | { content: string, grammar_version: number },
        conflict: null | string,        // conflicts[].id
        order?: number,                 // optional insertion position for local-new cards
        last_error?: { code, op, message, at }, // last push failure; cleared on success/resolve
        created_time, updated_time, pulled_at,
      } },
      conflicts: [ {
        id,                             // 'cf_<n>'
        kind: 'card-both-modified'|'card-remote-deleted'|'card-move-conflict'|'chapter-revision'|'deck-deleted',
        entity: 'card'|'chapter'|'deck', deck_id, chapter_id?, card_id?,
        base: string|null, local: string|null, remote: string|null,
        op: null|'rename'|'sort', detected_at, state: 'open',
      } ],
      moves: [ { id, deck_id, from_chapter_id, card_ids: string[], to_chapter_id, order: number|null, created_at } ],
      tasks: { [id]: SyncTask },       // background sync tasks; see "Background sync tasks and crash recovery"
    }

On disk: cards[content] -> cards.content, cards[text] -> cards.text (plain text, never part of the
data JSON), cards[cloud].content -> cards.base_content only when it differs,
cards[pending].content -> cards.pending_content; every other field stays in the cards data JSON.
Load hydrates them back (falling back to plainText(content) when the stored text is empty), so the
in-memory object above is the only shape sync.js sees.

Local id format: local_ + 12 lowercase hex chars, generated with node:crypto randomUUID
(fallback counter). Conflict id: cf_ + incrementing integer stored in meta.conflict_seq.

## lib/sync.js

    export function createEngine({ client, store, config, log, clock = Date.now })
    // returns {
    //   ready(): Promise<void>,             // load cache, start auto timer once
    //   start(): Promise<void>,             // load cache + start auto-sync timer if config.autoSync
    //   stop(): Promise<void>,              // clear timer, flush store
    //   status(): object,
    //   listDecks({ refresh, folder_id, scope, query, query_mode, predicate, fields,
    //               regex_flags, min_score } = {}): Promise<object>,
    //   listChapters({ deck, refresh, scope, query, query_mode, predicate, fields,
    //                  regex_flags, min_score } = {}): Promise<object>,
    //   listCards({ scope, deck, chapter, query, query_mode, predicate, fields, regex_flags,
    //               min_score, deck_name, chapter_name, updated_after, updated_before,
    //               limit, offset, refresh } = {}): Promise<object>,
    //   getCard({ card, deck } = {}): Promise<object>,
    //   getCards({ cards } = {}): Promise<{ cards, missing? }>,
    //   createCard({ deck, chapter, content, order, grammar_version }): Promise<object>,
    //   updateCard({ card, content, grammar_version }): Promise<object>,
    //   moveCards({ cards, to_chapter, order, deck }): Promise<object>,
    //   archiveCards({ cards }): Promise<object>,   // archive chapter + notice + move, idempotent
    //   failures({ card, deck, limit } = {}): Promise<object>, // conflicts + failed cards + recovery
    //   editChapter({ action, deck, chapter, name, order, chapter_ids }): Promise<object>,
    //   resolveConflict({ id, strategy, content }): Promise<object>,
    //   sync({ mode = 'auto', full = false } = {}): Promise<SyncReport>,
    //   pull({ full = false, reason } = {}): Promise<PullReport>,
    //   push({ reason } = {}): Promise<PushReport>,
    //   startSync({ mode = 'auto', full = false, resume = null } = {}): Promise<{ task: SyncTask, already_running?: true }>,
    //   syncTaskStatus({ task_id } = {}): { task: SyncTask } | { active: SyncTask|null, tasks: SyncTask[] },
    //   waitForTask(task_id, timeoutMs): Promise<SyncTask|null>,   // internal/tests
    //   hasPending(): boolean,
    //   ensureFresh(maxAgeMs): Promise<void>,
    //   touch(): void,                      // marks tool activity for idle detection
    // }

### Merge / pull semantics (must match exactly)

sync({mode}): pull = pull only; push = pull decks that contain local work, then push;
auto = pull (incremental, or all decks when full) then push. One mutex: concurrent
sync/pull/push calls queue, never interleave. A failed pull (network) aborts that sync
with a thrown MarkjiError; a failed per-card push is recorded and does not abort the rest.

pull({full}):

1. listFolders() -> replace cache.folders.
2. listAllDecks() -> upsert cache.decks; a cached deck absent from the list is remote-deleted.
3. Target decks = full ? all remote decks : (cached deck missing, or updated_time changed,
   or chapterset_revision null, or deck has local work). Never pull a deck twice.
4. For each target deck: listChapters(deck, { with_cards: true }). Map card_id -> chapter_id
   from chapter.card_ids; cards without a mapping keep their previous chapter_id or null.
   Replace/upsert chapters, chapterset_revision, chapter order (index in chapterset.chapter_ids).
5. Remote-deleted chapters: cached chapter of that deck absent from response -> if it has
   locally new/pending cards -> conflict chapter-revision (entity chapter, op null); else
   drop chapter from cache (drop its synced cards too).
   A remote-deleted chapter that still has local work (a local/pending card or a pending
   chapter op) is NOT dropped: set chapter.missing = true and record one chapter-revision
   conflict with op 'delete' (local = chapter name, remote = null); push skips its cards until
   the conflict is resolved. Remote-deleted deck: if it has any local work (dirty cards, local
   or pending chapters, pending_sort, moves) -> deck.missing = true, one deck-deleted conflict
   per dirty card, one chapter-revision op 'delete' conflict per local/pending chapter and one
   op 'sort' conflict for a pending sort; nothing is deleted from the cache and push skips the
   deck. Else drop deck + chapters + cards. Decks cannot be re-created through the API, so a
   deleted deck stays cached until the user resolves the conflicts (keep_remote drops the local
   work) or the deck reappears remotely.
6. Merge each remote card by card.revision vs cached.cloud.revision (and content equality):
   - new card id -> insert as synced (cloud snapshot, content = cloud.content, no pending).
   - same revision+content -> update cloud.updated_time/chapter_id only; if pending content
     equals remote content, clear pending (synced) without pushing.
   - revision changed:
     * no pending -> adopt remote (cloud snapshot + content), synced.
     * pending content === remote content -> remote already has the local edit: clear pending, adopt cloud.
     * pending differs -> conflict card-both-modified: base = old cloud.content,
       local = pending.content, remote = remote.content; set card.conflict, keep pending,
       keep content = local. Do not push while conflicted. Continue with other cards.
   - pending move exists for the card and the remote chapter differs from cloud.chapter_id and
     from the queued move target -> conflict card-move-conflict (base = old cloud chapter,
     local = queued move target, remote = current remote chapter). The queued move is dropped
     from cache.moves so push cannot retry a move that can never succeed; the conflict keeps
     the intent. Resolution: keep_local re-queues the move to the local target, keep_remote
     adopts the remote chapter, use_content is rejected.
7. Remote-deleted cards: cached card of a fully pulled deck missing from the response ->
   card with local pending -> conflict card-remote-deleted (keep pending, keep card);
   clean card -> delete from cache.
8. Update meta.last_pull_at (+ last_full_pull_at when full), meta.last_error = null; flush.
   Pull never sends write requests.

### Push semantics

Order (each item independent, catch per item, continue):

1. Local chapter creates (pending.op === 'create') sorted by order/creation: createChapter;
   remap the local id everywhere (chapters key, cards.chapter_id, moves.from/to_chapter_id,
   deck.pending_sort.chapter_ids, deck.chapter_ids). Store returned chapter + chapterset revision.
2. Chapter renames (pending.op === 'rename'): updateChapter({revision: pending.base_revision});
   on success clear pending and store returned revision; on provider error -> conflict
   chapter-revision (entity chapter, op rename, local=name), keep pending, record error entry.
3. Chapter sorts (deck.pending_sort): sortChapters({chapter_ids, revision: base_revision});
   success clears it, error -> chapter-revision conflict op sort.
4. Local card creates (local === true and not conflict): createCard with the card's chapter
   (must be real; remapped in step 1). Success: replace record with real id, cloud snapshot,
   clear pending/local, append id to chapter.card_ids. Failure: keep local, record error.
   Cards whose deck.missing or chapter.missing is true are skipped silently: their conflict is
   already visible and no request can succeed until it is resolved.
5. Card updates (pending and no conflict, not local): updateCard with grammar_version =
   cloud.grammar_version ?? card.grammar_version ?? config.grammarVersion. Success: cloud
   snapshot from returned card, content = pending.content, clear pending. Failure: keep
   pending, record error.
6. Moves: for each move whose card ids are real ids (locally new cards are removed from the
   move — creation already targets their chapter; drop empty moves): moveCards({chapter:
   from_chapter_id, card_ids, to_chapter_id, order}). Success: apply returned old_chapter /
   new_chapter card_ids/order to cache, set each card's chapter_id and cloud.chapter_id;
   remove move. Failure: keep move, record error.
7. meta.last_push_at = now when any push ran; flush. Never recreate/delete entities.

### Reports

    SyncReport = {
      ok: boolean,
      mode: 'auto'|'pull'|'push',
      started_at, finished_at, duration_ms,
      pull: { decks, chapters, cards, cards_deleted, adopted_cards, adopted_chapters,
              conflicts } | null,
      push: { chapters_created, chapters_renamed, chapters_sorted, cards_created, cards_updated,
              cards_moved, conflicts, errors: [{ op, id, message, code }] } | null,
      conflicts: ConflictView[],     // all open conflicts after the run
      errors: [{ op, id, message, code }],
      cache: { last_pull_at, last_push_at, pending_cards, pending_chapters },
    }
    ConflictView = { id, kind, entity, card_id?, chapter_id?, deck_id, local, remote, op,
                      detected_at, state }

sync() returns this report and stays the blocking pipeline used by the idle timer, pull/push
helpers and tests. The markji_sync TOOL does not return this report directly: it returns a
SyncTask handle immediately and the report becomes task.report when the background task
finishes (see "Background sync tasks and crash recovery"). Auto sync failures are logged and
stored in meta.last_error; they never throw out of the timer.

### Conflict lifecycle

- addConflict() is deduplicated: if an open conflict already matches (kind, entity, deck_id,
  chapter_id, card_id, op), its local/remote/base are refreshed and detected_at updated instead
  of appending a second entry. Repeated pulls/syncs therefore keep exactly one open conflict per
  issue, and resolving it closes it for good.
- Resolution by kind:
  * card-both-modified: keep_local re-queues the local content, keep_remote adopts cloud content,
    use_content queues the given content.
  * card-remote-deleted / deck-deleted (card): keep_local re-creates the card locally (new),
    keep_remote drops it from the cache.
  * card-move-conflict: keep_local re-queues the move, keep_remote adopts the remote chapter.
  * chapter-revision op rename: keep_local re-bases the rename on the current revision,
    keep_remote drops the queued rename and adopts the remote name.
  * chapter-revision op sort: keep_local re-bases the sort, keep_remote drops it.
  * chapter-revision op delete: keep_local re-creates the chapter (pending create) so its cards
    can be pushed, keep_remote deletes the cached chapter and its cards.
- A conflict never blocks other cards/chapters: push catches per item and continues.

### Background sync tasks and crash recovery

The markji_sync tool must return immediately because a first pull can take minutes (measured
2026-09 on this account: 5210 cards / 23 decks / 6.2 MB cache in about 160 s; now 5265 cards /
10.1 MB with the plain-text column). engine.startSync() creates a SyncTask,
persists it in cache.tasks, starts the pull/push pipeline in the background (void promise,
mutex-queued behind any running sync) and returns a task view at once.

    SyncTask (view) = {
      task_id: 'sync_<12 hex>',
      mode: 'auto'|'pull'|'push', full?: true,
      status: 'running'|'completed'|'failed'|'interrupted',
      started_at, finished_at: number|null,
      stage: 'starting'|'pull'|'push'|'done',
      progress: { message, decks_total, decks_done, <nonzero counters> },
      resume_count: number,
      error?: { code, message },
      hint?: string,                // running/interrupted/failed guidance
      report?: SyncReport,          // compact copy once completed
    }
    // task.updated_at and zero-valued counters stay internal. progress keeps
    // decks_total/decks_done plus only nonzero counters.

Rules:

- At most one task runs at a time, including across DSH processes sharing the cache:
  startSync returns { task: <running task view>, already_running: true } and starts nothing
  when this engine or the persisted cache already has a running task.
- Only the engine mutates cache.tasks; the status tool reads views (never the network).
- Progress events update task.progress, task.stage and task.updated_at, and schedule the normal
  debounced cache save; the task record itself is written with saveNow() when created/finished.
- Each task persists an internal owner { pid, host } outside the SyncTask view. start()
  (plugin load) marks a persisted 'running' task 'interrupted' (interrupted_at,
  error.code='interrupted') only when its owner is provably gone: no owner (legacy), a dead pid
  on this host, a stale task (>12 h, guards pid reuse), or another host last seen >1 h ago. A live
  task owned by another DSH process is left running, so starting a second process does not abort
  the first process's sync. Recovery runs under the cache writer lock. It never deletes a task.
- resume: startSync({ resume: task_id }) accepts an 'interrupted' task (a 'failed' task may also
  be retried): it keeps the id and started_at, sets status 'running', refreshes owner,
  resume_count += 1 and
  reruns the same pipeline. The pipeline always pulls before pushing.
- A resumed pull runs the idempotent-adoption pass:
  * a local chapter (pending create) whose name matches exactly one newly seen remote chapter of
    that deck is adopted (id remapped) instead of being created again;
  * a local card whose content matches exactly one newly seen remote card in its chapter is
    adopted instead of being created again (covers a crash between a provider create and the
    local id remap).
  Adoption only runs on a resumed task; normal pulls never merge local-new items with remote
  ones. Candidates must be unique; ambiguous matches are left to the normal push (a duplicate is
  possible, never data loss). report.pull gains adopted_cards / adopted_chapters counters.
- On success status='completed', report = SyncReport, meta.last_sync updated. On a thrown
  pipeline error status='failed' with error { code, message }; nothing throws at the tool call
  that already returned.
- Cache keeps the newest 20 tasks; completed/failed/interrupted tasks are pruned oldest-first,
  never the running one.
- stop() (plugin unload/disable) clears the timer, aborts an in-flight task at its next
  checkpoint, flushes the cache and marks it 'interrupted' before returning, so a resume is
  possible immediately after the plugin restarts; a process kill without stop() leaves the
  persisted task 'running' and start() turns it into 'interrupted' (same recovery path).
- Cancellation (engine.cancelTask) aborts the internal AbortController. The pipeline checks the
  signal between provider calls; an in-flight HTTP request is allowed to finish. The task is
  persisted as 'interrupted' with error.code='cancelled', queued edits are kept, and resume
  works normally.

Tools:

    markji_sync action=start    { mode?, full?, resume? } -> { task: SyncTask, job_id?, already_running? }  (no wait)
    markji_sync action=progress { task_id? }              -> { task: SyncTask } with task_id; otherwise { active: SyncTask|null, tasks: SyncTask[] }  // newest 3

### DSH background-job bridge

lib/jobs.js exposes a running SyncTask through DSH's own jobs service
('@deepseek-ai/dsh-tool-jobs'), so the Web UI lists it and DSH, not the plugin, owns completion
notification. It is optional at runtime:

- tools.js reads the service with ctx.get('jobs') (never a hard inject) and only attaches a job
  when the call has a live exec.agent. Without the service or agent the tool behaves exactly as
  before and returns no job_id; the persisted task remains the source of truth.
- jobs.start({ kind:'markji-sync', label, owner: <exec.agent.id>, toolCall, run(handle) }).
  run() registers engine.watchTaskProgress (immediate snapshot, then every applied progress
  event -> handle.updateProgress) and engine.watchTask (terminal view -> append a report summary,
  then settle the returned done promise with { status, detail, result: <task view> }). A running
  job returns { cancel(reason) { engine.cancelTask(task_id) }, done }.
- Mapping: completed -> completed, failed -> failed, interrupted/other -> killed. JobOutcome.result
  is a serialized task-view string (DSH interpolates it into job_output; an object would render
  as [object Object]). dsh-tool-jobs emits the completion notice; do not add a custom
  agent.followup message.
- Dedupe: one job per owner + task_id + resume_count. Repeated start calls that return
  already_running reuse the job id; resuming a task creates a new job.
- Killing the DSH job asks the engine to cancel; the task becomes interrupted and resumable.
  Disposing an owning session cancels its job and waits for the done promise.
- markji_sync action=progress remains the durable, DSH-independent inspection API.

### List filter pipeline

compileListFilter(args, tool, { textFields, defaultFields, predicateFields }) is the only
entry point for list filtering. It validates query_mode against FILTER_MODES, trims query,
compiles predicate with compilePredicate(tree, { fields: predicateFields }), rejects
query_mode=predicate without predicate or with query, validates fields, and builds one
createSearchMatcher (lib/search.js) reused for every row. filterRows calls filter.match(values)
for each row, lets applySearchHit add score/matched_by/snippet, and sorts fuzzy results by score
then natural order. Card-specific deck_name/chapter_name/updated_after/updated_before filters
run before the shared filter; partial fuzzy fallback runs only when no card matched and fields
includes text, and its entries are re-checked against the predicate.

lib/predicate.js compiles a JSON tree, never JavaScript. A condition is
{ field, op, value, case_sensitive?, flags? }; groups are { all }, { any }, { not }; ops are
eq/ne/contains/starts_with/ends_with/regex/in/not_in/gt/gte/lt/lte/exists. readPath walks own
properties only (no prototype access). Field roots are checked against the per-list allow-list,
and forbidden path segments (__proto__, prototype, constructor) are rejected at compile time.
String comparisons are case-insensitive by default (case_sensitive opts out), numbers compare
numerically, and gt/gte/lt/lte fall back to string ordering for ISO timestamps. Limits: depth 8,
64 nodes; invalid trees reject as invalid_argument before any row is evaluated.

### Read/lazy behavior

- Every public method calls touch() first.
- ensureFresh(maxAgeMs) = if no cache loaded -> load; if meta.last_pull_at is null/ancient
  (or maxAge 0) -> pull({full:false}). Read methods (refresh !== true) call
  ensureFresh(config.pullTtlMs); refresh === true forces pull({full:false}). If the pull
  throws, reads still serve the cache; the stale/error state is reported by markji_sync state.
- Missing-entity lookup (getCard/updateCard/createCard/moveCards/chapter create|rename) ->
  pull({full:false}) once (only decks the provider marks changed; a full pull of a large
  account takes minutes and a typo id must fail fast), retry, then throw MarkjiError
  (unknown_deck|unknown_chapter|unknown_card) with a hint to run markji_sync mode=pull
  full=true when the entity may exist on another device.
- Every list action (listDecks / listChapters / listCards) shares compileListFilter:
  scope, query, query_mode, predicate, fields, regex_flags, min_score. FILTER_MODES =
  substring (default) / fuzzy / regex / predicate. query and predicate AND together;
  query_mode=predicate requires predicate and rejects query. scope is inferred from
  deck / chapter / folder_id when omitted; an explicit conflict (scope=all with a target, or
  scope=deck without a deck) rejects with invalid_argument. fields must be a non-empty subset
  of the action's text fields. All filters run in memory over the loaded cache.
- listDecks -> { folders: [{ id, name, deck_count, parent_id? }], decks: [DeckView], total,
  hint? }. Folder items are no longer returned; DeckView.folder_id maps a deck to its folder
  and only DECK-kind folder items are counted. scope=all|folder (folder requires folder_id);
  query fields default name/description/id; predicate fields are DECK_PREDICATE_FIELDS.
  DeckView = { id, name, card_count, chapter_count, folder_id?, is_private?, source?,
  status?, missing?, description?, updated_time? }; description/updated_time only in getDeck,
  and default-valued flags are omitted.
- listChapters({deck}) -> { deck_id, deck_name, chapters: [ChapterView], total, hint? };
  without deck -> { decks: [{ deck_id, deck_name, chapters: [ChapterView] }], total, hint? }.
  scope=all|deck (deck requires deck); query fields default name/deck_name/id; predicate fields
  are CHAPTER_PREDICATE_FIELDS. With a filter active, deck groups with no matching chapters are
  omitted. ChapterView = { id, name, card_count, pending?, local?, missing? };
  getChapter/chapter_get (detail=true) adds revision, order and updated_time.
- listCards -> { total, offset, limit, has_more, cards: [CardSummary], partial?,
  fallback_terms?, hint? }. scope=all|deck|chapter (deck requires deck, chapter requires
  chapter; a supplied deck+chapter must agree). deck_name/chapter_name are case-insensitive
  substrings; updated_after/updated_before accept ISO 8601 or epoch milliseconds (numbers or
  numeric strings) and compare cloud.updated_time with the local updated_time fallback,
  inclusive; invalid or reversed times reject. limit 1-200 (default 50), offset >= 0.
  query fields default CARD_TEXT_FIELDS = text/id/deck_name/chapter_name; predicate fields are
  CARD_PREDICATE_FIELDS (including status, revision, updated_time, content, cloud, etc.).
  query_mode substring is a case-insensitive substring; fuzzy adds score and matched_by and
  sorts best-first (min_score threshold, default 0.6); regex is a JavaScript RegExp over the
  field (regex_flags i/m/s/u, default i) and adds matched_by. Formatting tags, media
  references, data URIs and base64 are excluded from text. If a fuzzy query has 3+ whitespace
  terms and no card matches all of them, it falls back to partial matches: result.partial =
  true, up to three rarest present terms become result.fallback_terms anchors, cards matching
  an anchor are ranked by anchor count then rarity, each card gets matched_terms, and
  result.hint explains the fallback. The fallback only runs when fields includes text, and any
  predicate is applied to fallback entries too. A zero-result query gets a hint suggesting a
  shorter phrase or regex alternative; a zero-result predicate gets its own hint. snippet is
  centred on the first text match. refresh=true forces a pull (otherwise the pull TTL applies).
  CardSummary = { id, deck_name, chapter_name, snippet, status? } plus optional score /
  matched_by / matched_terms. status is present only when it is dirty, new or conflict;
  revision, ids and updated_time are available through getCard.
- getCard -> { card: { id, deck_id, deck_name, chapter_id, chapter_name, content, text,
  grammar_version, status, cloud: {revision, updated_time} | null, pending?,
  conflict: ConflictView|null, last_error?, created_time, updated_time } }. content is the rich
  text needed for updates; text is the plain-text view used for reading/searching. Null optional
  fields (local/pending/conflict/last_error) are omitted.
- Writes validate: deck/chapter/card exist in cache (error unknown_deck|unknown_chapter|
  unknown_card with a hint to call markji_sync mode=pull full=true), non-empty content
  (max 100000 chars), identical content and grammar_version -> { ok: true, changed: false }.
  Writes mutate cache + markDirty() and return immediately (never call the network), except
  markji_file upload/query (direct cloud calls).
- createCard with order stores it on the card (used by push) — keep card.order optional field.
- moveCards validates target chapter (may be local, for cards created together with a
  chapter), updates card.chapter_id + chapter.card_ids order, and records one move entry (one
  per (deck, from, to, order) batch; append card ids if an equivalent pending move exists).
- editChapter: action create -> local chapter id, rename -> pending rename, sort ->
  deck.pending_sort. All no-network.
- resolveConflict strategies:
  * keep_local: card -> keep pending content (if remote still exists) or re-create as
    local-new (remote deleted); chapter rename/sort -> re-queue using the freshly cached
    revision; then clear conflict, changed: true.
  * keep_remote: card -> adopt remote.cloud.content (or remove card when remote deleted),
    drop pending; chapter -> drop pending rename or pending_sort.
  * use_content: card only; set pending content to content, conflict cleared, will push.
  Unknown id / already resolved / bad strategy -> { ok:false, error } (tool returns isError).

### Auto sync timer

start() loads the store, marks persisted 'running' tasks whose owner is gone as 'interrupted'
(crash recovery), then starts setInterval(tick, config.idleCheckMs); stop() clears it and flushes. Tick (no
throws): if a sync is running -> skip. If open conflicts exist -> do not start an auto sync
push (log debug once; they must be resolved first), but still allow the periodic pull path below.
Else if hasPending() and clock() - lastActivityAt >= idleQuietMs and
clock() - lastAutoFailureAt >= retryBackoffMs -> startSync({mode:'auto'}) and log when that task
settles; else if meta.last_pull_at older than autoPullMs and quiet -> pull({}). The pull path is
rate-limited by autoPullMs and by lastAutoFailureAt, so a permanently broken network cannot spin.
Log outcomes; on new conflicts log one warn line with ids. Do not wake agents or inject prompts.

## lib/card-syntax.js

Pure function; no I/O, no network. The single source of truth for raw Markji
syntax validation and media-id extraction. It never generates or rewrites
content, and there is no editor or compiler in this plugin.

- validateCardContent(content) -> { ok, errors, warnings, stats, media }.
  Errors have code, message, line (1-based), column (1-based), path and optional
  hint. Validation catches missing #, misplaced block tags, unknown tags, bad
  cloze groups, choice multi/correctness mistakes, formula delimiters, malformed
  media ids and unsafe nesting; it does not claim to model every valid Markji
  form. Markdown inline links/images are treated as literal content. media
  contains { kind: 'image'|'mask'|'audio', id, line, column } for valid Pic and
  Audio tags.
- markji_sync calls this same function before every card write, then checks the
  collected file ids with client.queryFiles. A syntax error, missing file, or
  failed query keeps the card queued with its error and skips its move.

## lib/tools.js + index.js

    export function registerTools(ctx, { engine, config, log }): () => void
    export function apply(ctx, rawConfig)            // in index.js; inject = ['tools']

- ctx.tools.register({ name, description, parameters, output: { schema: { type:'object' },
  render }, timeoutMs, execute }).
- execute(args, exec) normalizes args (objects only, coerced numbers, trimmed strings), calls
  one engine method, returns a plain JSON object. Errors: throw new Error message with
  provider code in the message (markji: <code>: <message>); the harness turns a thrown error
  into an isError result.
- render(_args, value) = one { type:'text', text: prettyJson(value, maxOutputChars) } block.
- Descriptions (English) must state: local cache + queued edits, markji_sync/idle auto-push,
  conflict recording, content syntax = Markji rich-text (plain text is valid), and that ids
  are OpenAPI ids.
- Tool names/args (exact; four action-based tools):

tool | action | args | returns
markji_decks | list (default) | { refresh?, folder_id?, scope?, query?, query_mode?, predicate?, fields?, regex_flags?, min_score? } | engine.listDecks
markji_decks | get | { deck, refresh? } | engine.getDeck (deck detail + chapters)
markji_decks | chapter_list | { deck?, refresh?, scope?, query?, query_mode?, predicate?, fields?, regex_flags?, min_score? } | engine.listChapters
markji_decks | chapter_get | { chapter, deck?, with_cards?, refresh? } | engine.getChapter (chapter detail + optional card summaries)
markji_decks | chapter_create | { deck, name, order? } | engine.editChapter({ action:'create' })
markji_decks | chapter_rename | { chapter, name, deck? } | engine.editChapter({ action:'rename' })
markji_decks | chapter_sort | { deck, chapter_ids } | engine.editChapter({ action:'sort' })
markji_cards | list (default) | { scope?, deck?, chapter?, query?, query_mode?, predicate?, fields?, regex_flags?, min_score?, deck_name?, chapter_name?, updated_after?, updated_before?, limit?, offset?, refresh? } | engine.listCards
markji_cards | get | { card?, cards?: string[], include_text? } | engine.getCards (per-id ok/error, one refresh on miss)
markji_cards | create | { deck?, chapter?, new_cards: [{content, deck?, chapter?, order?, grammar_version?}] } | engine.createCard per item (top-level targets are defaults; batch result)
markji_cards | update | { card, content, grammar_version? } or { updates: [{card, content, grammar_version?}] } | engine.updateCard per item (batch result)
markji_cards | move | { cards: string[], to_chapter, deck?, order? } | engine.moveCards
markji_cards | archive | { cards: string[] } | engine.archiveCards (archive chapter + notice + move)
markji_cards | validate | { content? or contents? or cards?: string[] } | validateCardContent per item (batch result)
markji_cards | syntax_help | { format? } | getSyntaxHelp
markji_sync | start (default) | { mode?: 'auto'|'pull'|'push', full?: bool, resume?: string } | engine.startSync (returns { task, already_running? } immediately)
markji_sync | progress | { task_id?: string } | engine.syncTaskStatus ({task} with task_id, otherwise {active,tasks}; no network)
markji_sync | state | {} | engine.status
markji_sync | failures | { card?, deck?, limit? } | engine.failures (conflicts, failed cards, recovery)
markji_sync | resolve | { id, strategy: 'keep_local'|'keep_remote'|'use_content', content? } | engine.resolveConflict
markji_file | upload/query | { action: 'upload'|'query', path?, ids?, expires?, deck? } | { file } / { files } (direct client call, not cached)

### Archive semantics

`archiveCards({ cards })`: reject open-conflict/unknown cards before mutating; validate every
new content length before creating anything; ensure a chapter named exactly `归档` in each
card's deck (create a local chapter when absent, id local_ch*); prepend
`\[已归档 YYYY-MM-DD\] 本卡片已归档，仅作历史保留，不再安排复习。` plus a blank line unless the
content already starts with `\[已归档`; queue the content update and move the card into that
chapter (moves are skipped for cards already there). An older unescaped `[已归档 ...]` notice is
normalized to the escaped form in place instead of adding a second notice. Re-running is
idempotent: no second notice, no duplicate move. The push preflights syntax and media first,
then creates the chapter, updates content, and moves cards; a card that fails preflight is not
moved.

### Batch semantics

`getCards({ cards })` de-duplicates ids while preserving request order, runs one
`ensureFresh` and at most one `forcePullForMissing('cards')`, then returns
`{ cards: [CardView], missing?: [id] }`; the tool strips `card.text` unless
`include_text` is true. `action=validate` builds an error item per `missing` id so a
bad id does not abort the batch. `markji_cards({ action:'validate' })` accepts exactly one of `content`,
`contents`, or `cards`; the cards mode validates the pending content when present
and reports `content_source`. `markji_cards({ action:'create' })` resolves each `new_cards` item's deck/chapter from the item
or the top-level defaults, then calls the single-card engine method once per
item; `action:'update'` does the same for `updates`, catch each
failure, preserve result order, and return `total / created|updated / failed /
partial` plus per-item results. Batch writes are not transactional: successful
items stay queued when another item fails. Every new batch entry is capped at
`MAX_BATCH_ITEMS = 50` (archive / move keep their existing behavior); batch get
defaults `include_text` to false to stay inside the tool-output budget.

### Failure report

`failureReport({ card, deck, limit })` reads the local cache (after idle refresh) and returns:
summary counts; open `conflicts` with entity/base/local/remote and `recovery { tool, arguments,
strategies, hint }`; `failed_cards` for cards whose `last_error` is set and that still have
pending/local work or a missing deck/chapter (successful push and conflict resolution clear it),
with `error { code, op, message, at }` and a per-item `recovery`; and
`last_task_errors` from the most recent task reports. There is no global static recovery block:
each conflict and failed card carries its own recovery. It accepts one card/deck filter and a
bounded limit, and never touches the network.

- markji_cards gets timeoutMs: 120000; markji_decks / markji_sync get 60000;
  markji_file uploads can be large, so keep 180000 for that one. markji_sync no longer waits
  for the network, so 60000 is enough to create the task.
- index.js: read config, create limiter -> client -> store -> engine, 4 tools, await engine.start()
  inside one ctx.effect registering tools + auto timer; cleanup stops timer, disposes tools,
  awaits engine.stop() (best effort). apply must return the disposer synchronously;
  ctx.effect may return a cleanup that awaits. Start engine with void engine.start().catch(...)
  and let tools await engine.ready() internally so the first tool call waits for the cache.
- Logging: [dsh-markji-bridge] <level> <message> via console; never log the token.

## Testing requirements (all owners)

- `node --test "test/*.test.js"` (plus independent `test/verify/*.test.js`) must pass from the
  package dir; no network in unit tests.
- api tests inject fetchImpl + fake limiter (immediate acquire) + fake clock; cover success
  envelope, provider error envelope, 401, retry 429/500, timeout, path encoding, request
  bodies for every write endpoint, multipart upload field name, queryFiles, not_configured.
- rate-limit tests use injected now/sleep to prove window accounting and wait estimate; no
  real sleeps > 5ms.
- store tests (test/store.test.js and independent test/verify/store.test.js) use a temp dir
  (mkdtemp) and cover fresh load, save/reload round-trip, cache.json and v2 migration, corrupt
  header quarantine, diff saves and stats, closing the SQLite handle before rm on Windows.
- sync tests (test/verify/merge.test.js + push.test.js fake clients, plus test/e2e-mock.mjs over
  real HTTP) cover every pull/push rule above, conflict recording/dedupe, per-card failure
  isolation, local id remapping, move/sort, deleted entities, resolve strategies, and that a
  push never runs while a conflict is open.
- Archive/failure tests (test/archive.test.js): archive chapter creation, notice prefix, move,
  idempotence, cloud push; conflict/failed-push reporting and recovery via retry/resolve;
  a successful move does not hide a failed content update; a failed queued move stays visible;
  a successful retry clears older task errors.
- Multi-process tests (test/multiprocess.test.js): two stores see each other's writes (including
  same-millisecond commits via SQLite data_version), the writer lock serializes two stores and a
  real child process, a stale dead-pid lock is reclaimed, a task waits with stage=waiting_lock,
  an engine read sees another engine's push, and a second engine start keeps a live task owned by
  another process.
- Background-task tests (test/sync-task.test.js): startSync returns a handle while a slow pull
  is still running; progress events advance and persist; only one task runs; a persisted
  'running' task with a provably dead owner is marked 'interrupted' by a new engine on the same
  dataDir and is resumable through the same handle; a resumed pull adopts already-created local
  cards/chapters instead of duplicating them; completion stores report and syncTaskStatus returns
  {task} for one task_id or {active,tasks} otherwise; watchTaskProgress emits live views and watchTask emits exactly one terminal view;
  cancelTask interrupts a running task at a checkpoint and leaves it resumable.
- DSH job bridge tests (test/jobs.test.js): labels/progress/summary/outcome mapping; startSyncJob
  registers with the jobs service, seeds progress, mirrors later progress, appends the terminal
  summary and resolves the job with the task; markji_sync action=start returns job_id when
  ctx.get('jobs') and exec.agent are present, reuses one job for the same session/task, does
  not require jobs when the service is unavailable, and does not create a job for a running task
  owned by another DSH process (that job could never settle locally).
- Cold load reads all v4 tables inside one SQLite transaction; refreshIfChanged combines file
  size/mtime with PRAGMA data_version so same-millisecond foreign commits are not missed.
- Filter tests (test/search.test.js, test/predicate.test.js, test/list-filter.test.js,
  test/tool-search.test.js): substring stays the default; fuzzy tolerates a one-character typo,
  adds score/matched_by, honors min_score, sorts best-first, ANDs all space-separated terms,
  does not pass a multi-term query on partial character overlap, falls back to
  rare-term-anchored partial matches with fallback_terms and matched_terms for 3+ terms when no
  card matches all, and returns a hint when a long query matches nothing; regex honors default
  i and explicit m, matches by id, rejects invalid patterns and flags; predicate covers all 13
  ops, all/any/not groups, dot paths, nested own-property reads, case sensitivity, depth/node
  limits, forbidden keys and invalid trees; listCards supports scope=all/deck/chapter with
  inferred and explicit conflicts, fields, predicate-only queries, predicate+query AND, and
  the partial fallback; listDecks/listChapters support query, fuzzy, predicate, scope and
  hints; the markji_cards tool merges query/query_mode/predicate/fields/scope into list,
  forwards regex_flags and min_score, and rejects invalid values, action=search and invalid
  query modes.
- Plain-text tests (test/plain-text.test.js): formatting tags keep visible text; media, data URIs
  and long bare base64 runs are dropped; markup must not be mistaken for Markdown links
  (str.[T#B#find](sub) -> str.find(sub)); listCards filters/snippets never match base64 or
  "[T#B#"/"Pic#ID"; card_get returns both rich content and plain text; a hand-built v3 cache is
  migrated to v4 with cards.text backfilled; the data JSON never contains text.
- Batch tests (test/batch.test.js): multi-id get preserves order and isolates unknown ids;
  syntax validates contents and cached cards (pending content wins); batch create and update
  queue good items and report bad items without aborting the rest; batch create resolves
  per-item deck/chapter targets and can span chapters and decks.
- Syntax tests (test/card-syntax.test.js): literal bracket escaping, styled/cloze/formula/choice/
  media/card-ref validation, validator errors and warnings, Markdown links/images treated as
  literal content, exact media extraction, placeholders, and no trimming of raw content.
- Media-preflight tests (test/media-preflight.test.js): valid media is pushed, missing media and
  invalid syntax are reported without cloud writes, a failed query keeps cards queued, and the
  registered 4 tools include markji_cards action=validate.
- Every test cleans up its temp dir. Tests must be deterministic (inject clock everywhere
  timestamps matter).

## Acceptance criteria

1. `node --test` green.
2. Bundle installs via plugin_manager install_bundle with application: applied and no
   warnings that affect loading; the 4 markji_* tools are visible to the agent.
3. Live read-only check with the real token: markji_decks action=list lists the real decks;
   markji_decks action=get / chapter_get and markji_cards action=list/get work on a real
   deck, including list filters with query_mode=fuzzy/regex and predicate; cache.db appears under the
   data dir.
4. Mock HTTP end-to-end (test/e2e-mock.mjs) proves create/update/move/chapter writes,
   pull-before-push, remote-change merge, conflict recording without aborting other cards,
   and local id remapping over real HTTP.
5. markji_sync action=start returns a task handle immediately (no network wait);
   markji_sync action=progress reports progress; a sync task persisted as 'running' by a killed process is listed as
   'interrupted' after reload and resumes through the same handle without duplicating cards.
   With dsh-tool-jobs loaded and a live owning session, start also returns job_id, the job is
   listed with live progress, job_output returns the task, DSH's completion notice is emitted
   when it settles, and killing the job interrupts the sync so it can be resumed.
6. README documents the four tools and their actions (including batch reads / creates / updates and syntax validation, chapter detail, media preflight, async task workflow and resume), config,
   cache/sync/conflict/archive/failure/multi-process semantics, data location, install/update/uninstall, and the verification
   actually performed (with dates and exact observed results, no invented claims).
