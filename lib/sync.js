// dsh-markji-bridge: pull / 3-way merge / push engine with idle auto-sync.
// Node builtins only; the client and store are injected so tests stay offline.
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { MarkjiError } from './api.js';
import { plainText } from './plain-text.js';
import { missingMedia, preflightContent, queryAvailableMedia } from './preflight.js';
import { compileFilter } from './filter.js';

const LOCAL_PREFIX = 'local_';
const CONTENT_MAX = 100000;
const TOOL_VERSION = '2.7.0';
const HOSTNAME = hostname();
/** A running task owned by another host cannot be probed; trust it for an hour. */
const TASK_FOREIGN_STALE_MS = 60 * 60 * 1000;
/** Guard against pid reuse after a crash: no real sync task runs for half a day. */
const TASK_OWNER_STALE_MS = 12 * 60 * 60 * 1000;
/** Cards are archived into this chapter of their own deck (created on demand). */
const ARCHIVE_CHAPTER_NAME = '归档';
const ARCHIVE_MARKER = '\\[已归档';
const CARD_FILTER_FIELDS = ['id', 'deck_id', 'deck_name', 'chapter_id', 'chapter_name', 'status', 'text', 'content', 'snippet', 'grammar_version', 'revision', 'updated_time', 'created_time', 'local', 'pending', 'conflict', 'last_error', 'cloud'];
const DECK_FILTER_FIELDS = ['id', 'name', 'description', 'card_count', 'chapter_count', 'updated_time', 'created_time', 'is_private', 'source', 'status', 'missing', 'folder_id'];
const CHAPTER_FILTER_FIELDS = ['id', 'name', 'deck_id', 'revision', 'order', 'card_count', 'updated_time', 'pending', 'local', 'missing'];

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function isLocalId(id) {
  return typeof id === 'string' && id.startsWith(LOCAL_PREFIX);
}
function makeLocalId(kind) {
  return LOCAL_PREFIX + kind + randomUUID().replace(/-/g, '').slice(0, 12);
}
function errMessage(error) {
  if (error === null || error === undefined) return 'unknown error';
  const source = typeof error === 'object' ? error : null;
  if (source !== null && typeof source.message === 'string' && source.message !== '') return source.message;
  return String(error);
}
function errorInfo(op, id, error) {
  const source = isObject(error) ? error : null;
  return {
    op,
    id: id === undefined || id === null ? null : id,
    message: errMessage(error),
    code: source !== null && typeof source.code === 'string' ? source.code : 'unknown',
  };
}
function fail(code, message, hint) {
  const error = new MarkjiError({ code, message, status: null, retriable: false, details: hint ? { hint } : null });
  if (typeof hint === 'string' && hint !== '') error.hint = hint;
  return error;
}
function snippet(text, limit = 160) {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  return value.length > limit ? value.slice(0, limit) + '...' : value;
}
function nowIso(clock) {
  return new Date(clock()).toISOString();
}
function dedupe(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    if (typeof value !== 'string' || value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}
function normalizeContent(content, tool) {
  if (typeof content !== 'string') throw fail('invalid_content', tool + ': content must be a string');
  const value = content.trim();
  if (value === '') throw fail('invalid_content', tool + ': content must not be empty');
  if (content.length > CONTENT_MAX) {
    throw fail('invalid_content', tool + ': content is ' + content.length + ' characters, max ' + CONTENT_MAX);
  }
  return content;
}
function numberOption(value, fallback, min, max) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value === undefined ? '' : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}
function timeOption(value, name) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw fail('invalid_argument', name + ' must be an ISO 8601 time or epoch milliseconds');
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (/^\d{10,14}$/.test(text)) {
      const numeric = Number(text);
      if (!Number.isSafeInteger(numeric)) throw fail('invalid_argument', name + ' epoch milliseconds are out of range: ' + value);
      return numeric < 1e12 ? numeric * 1000 : numeric;
    }
    const parsed = Date.parse(text);
    if (!Number.isFinite(parsed)) throw fail('invalid_argument', name + ' is not a valid ISO 8601 time: ' + value);
    return parsed;
  }
  throw fail('invalid_argument', name + ' must be an ISO 8601 time or epoch milliseconds');
}
function sameArray(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** Serial mutex: every sync/pull/push runs alone and later calls queue. */
function emptyTaskProgress(message) {
  return {
    message,
    decks_total: 0,
    decks_done: 0,
    chapters: 0,
    cards: 0,
    cards_deleted: 0,
    adopted_cards: 0,
    adopted_chapters: 0,
    conflicts_created: 0,
    chapters_created: 0,
    chapters_renamed: 0,
    chapters_sorted: 0,
    cards_created: 0,
    cards_updated: 0,
    cards_moved: 0,
    errors: 0,
  };
}

function createMutex() {
  let tail = Promise.resolve();
  return function withLock(operation) {
    const run = tail.then(operation);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export function createEngine(options = {}) {
  const client = options.client;
  const store = options.store;
  if (!client || typeof client.listAllDecks !== 'function') throw new Error('createEngine: client is required');
  if (!store || typeof store.load !== 'function') throw new Error('createEngine: store is required');
  const rawConfig = isObject(options.config) ? options.config : {};
  const config = {
    baseUrl: typeof rawConfig.baseUrl === 'string' && rawConfig.baseUrl !== '' ? rawConfig.baseUrl : 'https://open.maimemo.com/open',
    grammarVersion: numberOption(rawConfig.grammarVersion, 3, 1, 99),
    pageSize: numberOption(rawConfig.pageSize, 100, 1, 100),
    pullTtlMs: numberOption(rawConfig.pullTtlMs, 600000, 0, 86400000),
    autoSync: rawConfig.autoSync !== false,
    idleCheckMs: numberOption(rawConfig.idleCheckMs, 30000, 1000, 3600000),
    idleQuietMs: numberOption(rawConfig.idleQuietMs, 120000, 0, 86400000),
    autoPullMs: numberOption(rawConfig.autoPullMs, 900000, 0, 86400000),
    retryBackoffMs: numberOption(rawConfig.retryBackoffMs, 300000, 0, 86400000),
  };
  const log = typeof options.log === 'function' ? options.log : () => {};
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const withLock = createMutex();

  let readyPromise = null;
  let timer = null;
  let disposed = false;
  let started = false;
  let syncing = false;
  let lastActivityAt = clock();
  let lastAutoFailureAt = 0;
  let lastReadError = null;
  let activeTaskId = null;
  const taskPromises = new Map();
  const taskWatchers = new Map();
  const taskProgressWatchers = new Map();
  const taskAborts = new Map();
  const TASK_HISTORY_LIMIT = 20;

  function cache() {
    return store.cache;
  }
  function touch() {
    lastActivityAt = clock();
  }
  function ready() {
    if (readyPromise === null) {
      readyPromise = (async () => {
        await store.load();
        return store.cache;
      })();
      readyPromise.catch(() => {
        readyPromise = null;
      });
    }
    return readyPromise;
  }
  /** Refresh the read snapshot from disk unless this process owns a running task. */
  async function refreshIfIdle() {
    if (activeTaskId === null && !syncing && store.writeLocked !== true) await store.refreshIfChanged();
  }
  function hasPending() {
    const current = cache();
    for (const card of Object.values(current.cards)) {
      if (card.pending || card.local || card.conflict) return true;
    }
    for (const chapter of Object.values(current.chapters)) {
      if (chapter.pending || chapter.local) return true;
    }
    for (const deck of Object.values(current.decks)) {
      if (deck.pending_sort) return true;
    }
    return current.moves.length > 0;
  }
  function pendingCounts() {
    const current = cache();
    const cards = Object.values(current.cards);
    const chapters = Object.values(current.chapters);
    return {
      cards_new: cards.filter((card) => card.local).length,
      cards_dirty: cards.filter((card) => !card.local && card.pending).length,
      chapters_new: chapters.filter((chapter) => chapter.local).length,
      chapters_rename: chapters.filter((chapter) => chapter.pending && chapter.pending.op === 'rename').length,
      moves: current.moves.reduce((sum, move) => sum + move.card_ids.length, 0),
      sorts: Object.values(current.decks).filter((deck) => deck.pending_sort).length,
      conflicts: current.conflicts.filter((conflict) => conflict.state === 'open').length,
    };
  }
  function openConflicts() {
    return cache().conflicts.filter((conflict) => conflict.state === 'open');
  }
  function conflictViews() {
    return openConflicts().map((conflict) => ({
      id: conflict.id,
      kind: conflict.kind,
      entity: conflict.entity,
      deck_id: conflict.deck_id ?? null,
      chapter_id: conflict.chapter_id ?? null,
      card_id: conflict.card_id ?? null,
      local: conflict.local ?? null,
      remote: conflict.remote ?? null,
      op: conflict.op ?? null,
      detected_at: conflict.detected_at ?? null,
      state: conflict.state,
    }));
  }
  function addConflict(fields) {
    const current = cache();
    const existing = current.conflicts.find(
      (entry) =>
        entry.state === 'open' &&
        entry.kind === fields.kind &&
        entry.entity === fields.entity &&
        (entry.deck_id ?? null) === (fields.deck_id ?? null) &&
        (entry.chapter_id ?? null) === (fields.chapter_id ?? null) &&
        (entry.card_id ?? null) === (fields.card_id ?? null) &&
        (entry.op ?? null) === (fields.op ?? null),
    );
    if (existing) {
      if (fields.base !== undefined) existing.base = fields.base;
      if (fields.local !== undefined) existing.local = fields.local;
      if (fields.remote !== undefined) existing.remote = fields.remote;
      existing.detected_at = clock();
      return existing.id;
    }
    current.meta.conflict_seq = (current.meta.conflict_seq ?? 0) + 1;
    const conflict = {
      id: 'cf_' + String(current.meta.conflict_seq),
      kind: fields.kind,
      entity: fields.entity,
      deck_id: fields.deck_id ?? null,
      chapter_id: fields.chapter_id ?? null,
      card_id: fields.card_id ?? null,
      base: fields.base ?? null,
      local: fields.local ?? null,
      remote: fields.remote ?? null,
      op: fields.op ?? null,
      detected_at: clock(),
      state: 'open',
    };
    current.conflicts.push(conflict);
    return conflict.id;
  }
  function conflictView(id) {
    if (!id) return null;
    const conflict = cache().conflicts.find((entry) => entry.id === id);
    if (!conflict) return null;
    return {
      id: conflict.id,
      kind: conflict.kind,
      entity: conflict.entity,
      deck_id: conflict.deck_id ?? null,
      chapter_id: conflict.chapter_id ?? null,
      card_id: conflict.card_id ?? null,
      local: conflict.local ?? null,
      remote: conflict.remote ?? null,
      op: conflict.op ?? null,
      detected_at: conflict.detected_at ?? null,
      state: conflict.state,
    };
  }
  function cacheInfo() {
    const meta = cache().meta;
    const stale = meta.last_pull_at === null || meta.last_pull_at === undefined || clock() - meta.last_pull_at > config.pullTtlMs;
    return { pulled_at: meta.last_pull_at ?? null, stale: lastReadError !== null ? true : stale, error: lastReadError };
  }
  function hasPendingMove(cardId) {
    return cache().moves.some((move) => move.card_ids.includes(cardId));
  }
  function detachCardId(cardId) {
    const current = cache();
    for (const chapter of Object.values(current.chapters)) {
      if (Array.isArray(chapter.card_ids)) chapter.card_ids = chapter.card_ids.filter((id) => id !== cardId);
    }
    for (const move of current.moves) move.card_ids = move.card_ids.filter((id) => id !== cardId);
    current.moves = current.moves.filter((move) => move.card_ids.length > 0);
  }
  function deckHasLocalWork(deckId) {
    const current = cache();
    for (const card of Object.values(current.cards)) {
      if (card.deck_id === deckId && (card.local || card.pending || card.conflict)) return true;
    }
    for (const chapter of Object.values(current.chapters)) {
      if (chapter.deck_id === deckId && (chapter.local || chapter.pending)) return true;
    }
    if (current.decks[deckId] && current.decks[deckId].pending_sort) return true;
    return current.moves.some((move) => move.deck_id === deckId);
  }
  function cardStatus(card) {
    if (card.conflict) return 'conflict';
    if (card.local) return 'new';
    if (card.pending) return 'dirty';
    return 'synced';
  }
  function chapterView(chapter, detail = false) {
    const view = {
      id: chapter.id,
      name: chapter.name,
      card_count: Array.isArray(chapter.card_ids) ? chapter.card_ids.length : 0,
    };
    if (chapter.pending) view.pending = { op: chapter.pending.op, name: chapter.pending.name ?? null };
    if (chapter.local === true) view.local = true;
    if (chapter.missing === true) view.missing = true;
    if (detail) {
      view.revision = chapter.revision ?? null;
      view.order = chapter.order ?? 0;
      view.updated_time = chapter.updated_time ?? null;
    }
    return view;
  }
  function deckView(deck, options = {}) {
    const view = {
      id: deck.id,
      name: deck.name,
      card_count: deck.card_count ?? 0,
      chapter_count: deck.chapter_count ?? 0,
    };
    if (options.folder_id) view.folder_id = options.folder_id;
    if (deck.is_private === true) view.is_private = true;
    if (typeof deck.source === 'string' && deck.source !== 'SELF') view.source = deck.source;
    if (typeof deck.status === 'string' && deck.status !== 'NORMAL') view.status = deck.status;
    if (deck.missing === true) view.missing = true;
    if (options.detail === true) {
      if (typeof deck.description === 'string' && deck.description !== '') view.description = deck.description;
      view.updated_time = deck.updated_time ?? null;
    }
    return view;
  }
  function cardSummary(card) {
    const chapter = cache().chapters[card.chapter_id];
    const deck = cache().decks[card.deck_id];
    const summary = {
      id: card.id,
      deck_name: deck ? deck.name : null,
      chapter_name: chapter ? chapter.name : null,
      snippet: snippet(plainText(card.content)),
    };
    const status = cardStatus(card);
    if (status !== 'synced') summary.status = status;
    return summary;
  }
  function cardDetail(card) {
    const chapter = cache().chapters[card.chapter_id];
    const deck = cache().decks[card.deck_id];
    const view = {
      id: card.id,
      deck_id: card.deck_id,
      deck_name: deck ? deck.name : null,
      chapter_id: card.chapter_id ?? null,
      chapter_name: chapter ? chapter.name : null,
      content: card.content,
      text: plainText(card.content),
      grammar_version: card.grammar_version ?? config.grammarVersion,
      status: cardStatus(card),
      cloud: card.cloud ? { revision: card.cloud.revision, updated_time: card.cloud.updated_time ?? null } : null,
      created_time: card.created_time ?? null,
      updated_time: card.updated_time ?? null,
    };
    if (card.local === true) view.local = true;
    if (card.pending) view.pending = { content: card.pending.content, grammar_version: card.pending.grammar_version };
    if (card.conflict) view.conflict = conflictView(card.conflict);
    if (card.last_error) view.last_error = card.last_error;
    return view;
  }
  function setCardError(card, op, error) {
    if (!card) return;
    const info = errorInfo(op, card.id, error);
    card.last_error = { op: info.op, code: info.code, message: info.message, at: nowIso(clock) };
  }
  function clearCardError(card, op) {
    if (!card || card.last_error === undefined) return;
    // A successful different operation (e.g. a queued move) must not hide a
    // still-actionable failure such as a failed content update.
    if (op !== undefined && card.last_error.op !== op) return;
    delete card.last_error;
  }
  function orderedCards() {
    const current = cache();
    const out = [];
    const seen = new Set();
    const decks = Object.values(current.decks).sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const deck of decks) {
      const chapters = Object.values(current.chapters)
        .filter((chapter) => chapter.deck_id === deck.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)));
      for (const chapter of chapters) {
        for (const id of chapter.card_ids ?? []) {
          const card = current.cards[id];
          if (card && !seen.has(id)) {
            seen.add(id);
            out.push(card);
          }
        }
      }
    }
    for (const card of Object.values(current.cards)) {
      if (!seen.has(card.id)) out.push(card);
    }
    return out;
  }

  /** Read and validate an optional list scope. */
  function readScope(args, tool, allowed) {
    if (args.scope === undefined || args.scope === null || args.scope === '') return null;
    if (typeof args.scope !== 'string' || !allowed.includes(args.scope)) {
      throw fail('invalid_argument', tool + ': scope must be one of: ' + allowed.join(', '));
    }
    return args.scope;
  }

  const LEGACY_FILTER_ARGUMENTS = ['query', 'query_mode', 'predicate', 'fields', 'regex_flags', 'min_score'];

  /** Reject the removed text-query API instead of silently ignoring it. */
  function rejectLegacyFilterArgs(args, tool) {
    for (const key of LEGACY_FILTER_ARGUMENTS) {
      if (!Object.prototype.hasOwnProperty.call(args, key)) continue;
      throw fail('invalid_argument', tool + ': "' + key + '" is no longer supported; pass filter: {<condition tree>} instead');
    }
  }

  /** Read and compile one list's optional JSON filter tree. */
  function readFilterTree(args, tool, allowedFields) {
    rejectLegacyFilterArgs(args, tool);
    const raw = args.filter;
    if (raw === undefined || raw === null) return null;
    if (!isObject(raw)) throw fail('invalid_argument', tool + ': filter must be an object');
    // {} is the natural no-filter value when a caller builds arguments dynamically.
    if (Object.keys(raw).length === 0) return null;
    try {
      return compileFilter(raw, { fields: allowedFields });
    } catch (error) {
      throw fail('invalid_argument', tool + ': ' + errMessage(error));
    }
  }

  function filterMatcher(args, tool, allowedFields) {
    const filter = readFilterTree(args, tool, allowedFields);
    return {
      filter,
      matches(values) {
        return filter === null || filter(values);
      },
    };
  }

  // Each list has its own field allow-list: decks only see deck fields,
  // chapters only see chapter fields, and cards keep the larger card-only set.
  function compileDeckFilter(args) {
    return filterMatcher(args, 'markji_decks', DECK_FILTER_FIELDS);
  }

  function compileChapterFilter(args) {
    return filterMatcher(args, 'markji_chapters', CHAPTER_FILTER_FIELDS);
  }

  function compileCardFilter(args) {
    return filterMatcher(args, 'markji_cards', CARD_FILTER_FIELDS);
  }

  /** Apply a compiled filter to rows of { values, view }, preserving natural order. */
  function filterRows(rows, filter) {
    const out = [];
    for (const row of rows) {
      if (filter.matches(row.values)) out.push(row.view);
    }
    return out;
  }

  // ---------------------------------------------------------------- pull ----

  function upsertDeck(remote) {
    const current = cache();
    const previous = current.decks[remote.id];
    const next = {
      id: remote.id,
      name: remote.name,
      description: remote.description ?? '',
      revision: remote.revision ?? previous?.revision ?? 0,
      is_private: remote.is_private === true,
      source: remote.source ?? previous?.source ?? 'SELF',
      status: remote.status ?? previous?.status ?? 'NORMAL',
      card_count: remote.card_count ?? previous?.card_count ?? 0,
      chapter_count: remote.chapter_count ?? previous?.chapter_count ?? 0,
      created_time: remote.created_time ?? previous?.created_time ?? null,
      updated_time: remote.updated_time ?? previous?.updated_time ?? null,
      chapterset_revision: previous?.chapterset_revision ?? null,
      chapter_ids: previous?.chapter_ids ?? [],
      pending_sort: previous?.pending_sort ?? null,
      missing: previous?.missing === true,
      pulled_at: previous?.pulled_at ?? 0,
    };
    current.decks[remote.id] = next;
  }
  function mergeRemoteChapter(remote, order, deckId, report) {
    const current = cache();
    const cached = current.chapters[remote.id];
    if (cached && cached.local) return;
    const cardIds = Array.isArray(remote.card_ids) ? remote.card_ids.slice() : [];
    if (!cached) {
      current.chapters[remote.id] = {
        id: remote.id,
        deck_id: deckId,
        name: remote.name,
        revision: remote.revision ?? null,
        updated_time: remote.updated_time ?? null,
        order,
        card_ids: cardIds,
        pulled_at: clock(),
      };
      report.chapters += 1;
      return;
    }
    const pending = cached.pending;
    if (pending && pending.op === 'rename' && cached.revision !== null && remote.revision !== cached.revision) {
      addConflict({
        kind: 'chapter-revision',
        entity: 'chapter',
        deck_id: deckId,
        chapter_id: remote.id,
        local: pending.name,
        remote: remote.name,
        op: 'rename',
      });
      report.conflicts += 1;
      cached.revision = remote.revision ?? cached.revision;
      cached.updated_time = remote.updated_time ?? cached.updated_time;
      cached.card_ids = cardIds;
      cached.order = order;
      cached.pulled_at = clock();
      return;
    }
    cached.name = pending && pending.op === 'rename' ? cached.name : remote.name;
    cached.revision = remote.revision ?? cached.revision;
    cached.updated_time = remote.updated_time ?? cached.updated_time;
    cached.card_ids = cardIds;
    cached.order = order;
    cached.pulled_at = clock();
    delete cached.missing;
    report.chapters += 1;
  }
  function mergeRemoteCard(remote, chapterId, report) {
    const current = cache();
    const remoteSnapshot = {
      revision: remote.revision ?? 0,
      content: remote.content ?? '',
      grammar_version: remote.grammar_version ?? config.grammarVersion,
      content_type: remote.content_type ?? null,
      updated_time: remote.updated_time ?? null,
      chapter_id: chapterId ?? null,
      status: remote.status ?? 'NORMAL',
    };
    const cached = current.cards[remote.id];
    if (!cached) {
      current.cards[remote.id] = {
        id: remote.id,
        deck_id: remote.deck_id,
        chapter_id: chapterId ?? null,
        content: remoteSnapshot.content,
        grammar_version: remoteSnapshot.grammar_version,
        cloud: remoteSnapshot,
        pending: null,
        conflict: null,
        created_time: remote.created_time ?? null,
        updated_time: remoteSnapshot.updated_time,
        pulled_at: clock(),
      };
      report.cards += 1;
      return;
    }
    const oldCloud = cached.cloud;
    const revisionChanged = !oldCloud || oldCloud.revision !== remoteSnapshot.revision;
    const contentChanged =
      !oldCloud || oldCloud.content !== remoteSnapshot.content || (oldCloud.chapter_id ?? null) !== (chapterId ?? null);
    if (!revisionChanged && !contentChanged) {
      if (oldCloud) {
        oldCloud.updated_time = remoteSnapshot.updated_time;
        oldCloud.chapter_id = chapterId ?? null;
      }
      if (cached.pending && cached.pending.content === remoteSnapshot.content) {
        cached.pending = null;
        cached.content = remoteSnapshot.content;
        cached.cloud = remoteSnapshot;
        cached.updated_time = remoteSnapshot.updated_time;
        clearCardError(cached);
      }
      cached.pulled_at = clock();
      return;
    }
    if (cached.pending && cached.pending.content !== remoteSnapshot.content) {
      const conflictId = addConflict({
        kind: 'card-both-modified',
        entity: 'card',
        deck_id: cached.deck_id,
        chapter_id: chapterId ?? null,
        card_id: cached.id,
        base: oldCloud ? oldCloud.content : null,
        local: cached.pending.content,
        remote: remoteSnapshot.content,
      });
      cached.conflict = conflictId;
      cached.cloud = remoteSnapshot;
      if (chapterId) cached.cloud.chapter_id = chapterId;
      cached.pulled_at = clock();
      report.conflicts += 1;
      return;
    }
    if (cached.pending && cached.pending.content === remoteSnapshot.content) {
      cached.pending = null;
      clearCardError(cached);
    }
    const moveEntry = hasPendingMove(cached.id)
      ? cache().moves.find((move) => Array.isArray(move.card_ids) && move.card_ids.includes(cached.id))
      : null;
    const localMoveTarget = moveEntry ? moveEntry.to_chapter_id : null;
    cached.content = remoteSnapshot.content;
    cached.grammar_version = remoteSnapshot.grammar_version;
    cached.cloud = remoteSnapshot;
    cached.chapter_id = chapterId ?? cached.chapter_id;
    cached.updated_time = remoteSnapshot.updated_time;
    cached.pulled_at = clock();
    if (moveEntry && localMoveTarget && chapterId && localMoveTarget === chapterId) {
      // The remote already has the card where the queued move wants it; retrying the
      // move would always fail (common_invalid_param). Drop it silently.
      moveEntry.card_ids = moveEntry.card_ids.filter((id) => id !== cached.id);
      cache().moves = cache().moves.filter((move) => move.card_ids.length > 0);
    } else if (
      moveEntry &&
      oldCloud &&
      oldCloud.chapter_id &&
      chapterId &&
      oldCloud.chapter_id !== chapterId &&
      localMoveTarget &&
      localMoveTarget !== chapterId
    ) {
      // The queued local move and a concurrent remote move disagree. Record it and
      // drop the queued move: it can never succeed against the remote chapter, and
      // resolving the conflict re-queues it (keep_local) or adopts the remote one.
      const conflictId = addConflict({
        kind: 'card-move-conflict',
        entity: 'card',
        deck_id: cached.deck_id,
        chapter_id: chapterId,
        card_id: cached.id,
        base: oldCloud.chapter_id,
        local: localMoveTarget,
        remote: chapterId,
      });
      cached.conflict = conflictId;
      if (cached.cloud) cached.cloud.chapter_id = chapterId;
      moveEntry.card_ids = moveEntry.card_ids.filter((id) => id !== cached.id);
      cache().moves = cache().moves.filter((move) => move.card_ids.length > 0);
      report.conflicts += 1;
      report.cards += 1;
      return;
    }
    report.cards += 1;
  }
  function applyLocalRouting(deckId) {
    const current = cache();
    const chapters = Object.values(current.chapters).filter((chapter) => chapter.deck_id === deckId);
    for (const card of Object.values(current.cards)) {
      if (card.deck_id !== deckId) continue;
      const movePending = hasPendingMove(card.id);
      const reroute = card.local === true || movePending || (card.chapter_id && card.cloud && card.cloud.chapter_id !== card.chapter_id);
      if (!reroute) continue;
      for (const chapter of chapters) chapter.card_ids = (chapter.card_ids ?? []).filter((id) => id !== card.id);
      const target = current.chapters[card.chapter_id];
      if (!target || target.deck_id !== deckId) continue;
      if (!Array.isArray(target.card_ids)) target.card_ids = [];
      if (Number.isInteger(card.order)) {
        const at = Math.max(0, Math.min(card.order, target.card_ids.length));
        target.card_ids.splice(at, 0, card.id);
      } else {
        target.card_ids.push(card.id);
      }
    }
  }
  function handleMissingDeck(deckId, report) {
    const current = cache();
    const deck = current.decks[deckId];
    if (!deck) return;
    const dirty = Object.values(current.cards).filter(
      (card) => card.deck_id === deckId && (card.pending || card.local || card.conflict),
    );
    if (deckHasLocalWork(deckId)) {
      deck.missing = true;
      for (const card of dirty) {
        if (card.conflict) continue;
        const conflictId = addConflict({
          kind: 'deck-deleted',
          entity: 'deck',
          deck_id: deckId,
          card_id: card.id,
          base: card.cloud ? card.cloud.content : null,
          local: card.pending ? card.pending.content : card.content,
          remote: null,
        });
        card.conflict = conflictId;
        report.conflicts += 1;
      }
      for (const chapter of Object.values(current.chapters)) {
        if (chapter.deck_id !== deckId || (!chapter.local && !chapter.pending)) continue;
        addConflict({
          kind: 'chapter-revision',
          entity: 'chapter',
          deck_id: deckId,
          chapter_id: chapter.id,
          op: 'delete',
          local: chapter.name,
          remote: null,
        });
        report.conflicts += 1;
      }
      if (deck.pending_sort) {
        addConflict({
          kind: 'chapter-revision',
          entity: 'chapter',
          deck_id: deckId,
          chapter_id: null,
          op: 'sort',
          local: deck.pending_sort.chapter_ids.join(','),
          remote: null,
        });
        report.conflicts += 1;
      }
      return;
    }
    delete current.decks[deckId];
    for (const chapter of Object.values(current.chapters)) {
      if (chapter.deck_id === deckId) delete current.chapters[chapter.id];
    }
    for (const card of Object.values(current.cards)) {
      if (card.deck_id === deckId) {
        detachCardId(card.id);
        delete current.cards[card.id];
      }
    }
    current.moves = current.moves.filter((move) => move.deck_id !== deckId);
  }
  async function pullInternal(options = {}) {
    const full = options.full === true;
    const signal = options.signal;
    const check = () => {
      if (signal !== undefined && signal.aborted) throw new Error('sync task cancelled');
    };
    await ready();
    check();
    const current = cache();
    const emit = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    const report = { decks: 0, chapters: 0, cards: 0, cards_deleted: 0, adopted_cards: 0, adopted_chapters: 0, conflicts: 0 };
    const folders = await client.listFolders();
    check();
    current.folders = {};
    for (const folder of Array.isArray(folders) ? folders : []) {
      if (!folder || typeof folder.id !== 'string') continue;
      current.folders[folder.id] = {
        id: folder.id,
        name: folder.name ?? '',
        parent_id: folder.parent_id ?? null,
        items: Array.isArray(folder.items) ? folder.items.map((item) => ({
          object_id: item.object_id,
          object_class: item.object_class,
          ...(item.order === undefined ? {} : { order: item.order }),
        })) : [],
        pulled_at: clock(),
      };
    }
    const remoteDecks = await client.listAllDecks({ pageSize: config.pageSize });
    check();
    const remoteDeckIds = new Set(remoteDecks.map((deck) => deck.id));
    const targets = [];
    for (const remoteDeck of remoteDecks) {
      const cached = current.decks[remoteDeck.id];
      const changed =
        !cached ||
        cached.updated_time !== (remoteDeck.updated_time ?? null) ||
        cached.chapterset_revision === null ||
        cached.chapterset_revision === undefined ||
        deckHasLocalWork(remoteDeck.id);
      upsertDeck(remoteDeck);
      if (full || changed) targets.push(remoteDeck);
    }
    emit({ stage: 'pull', phase: 'plan', decks_total: targets.length, decks_seen: remoteDecks.length });
    for (const deckId of Object.keys(current.decks)) {
      if (remoteDeckIds.has(deckId)) continue;
      handleMissingDeck(deckId, report);
    }
    let decksDone = 0;
    for (const remoteDeck of targets) {
      check();
      const knownChapterIds = new Set(
        Object.values(current.chapters)
          .filter((chapter) => chapter.deck_id === remoteDeck.id && chapter.local !== true)
          .map((chapter) => chapter.id),
      );
      const knownCardIds = new Set(
        Object.values(current.cards)
          .filter((card) => card.deck_id === remoteDeck.id && card.local !== true)
          .map((card) => card.id),
      );
      const data = await client.listChapters(remoteDeck.id, { with_cards: true });
      check();
      const chapterset = data && data.chapterset ? data.chapterset : null;
      const chapters = data && Array.isArray(data.chapters) ? data.chapters : [];
      const cards = data && Array.isArray(data.cards) ? data.cards : [];
      const chapterIds = chapterset && Array.isArray(chapterset.chapter_ids) && chapterset.chapter_ids.length > 0
        ? chapterset.chapter_ids.slice()
        : chapters.map((chapter) => chapter.id);
      const orderById = new Map(chapterIds.map((id, index) => [id, index]));
      const cardChapter = new Map();
      for (const chapter of chapters) {
        for (const cardId of chapter.card_ids ?? []) cardChapter.set(cardId, chapter.id);
      }
      const remoteChapterIds = new Set(chapterIds);
      for (const chapter of chapters) {
        mergeRemoteChapter(chapter, orderById.has(chapter.id) ? orderById.get(chapter.id) : 0, remoteDeck.id, report);
      }
      for (const chapter of Object.values(current.chapters)) {
        if (chapter.deck_id !== remoteDeck.id || chapter.local || remoteChapterIds.has(chapter.id)) continue;
        if (chapterHasLocalWork(chapter.id) || chapter.pending) {
          chapter.missing = true;
          addConflict({
            kind: 'chapter-revision',
            entity: 'chapter',
            deck_id: remoteDeck.id,
            chapter_id: chapter.id,
            op: 'delete',
            base: null,
            local: chapter.name,
            remote: null,
          });
          report.conflicts += 1;
        } else {
          for (const card of Object.values(current.cards)) {
            if (card.chapter_id === chapter.id) {
              detachCardId(card.id);
              delete current.cards[card.id];
            }
          }
          delete current.chapters[chapter.id];
        }
      }
      const remoteCardIds = new Set(cards.map((card) => card.id));
      for (const card of cards) {
        mergeRemoteCard(card, cardChapter.get(card.id) ?? null, report);
      }
      if (options.adoptLocal === true) {
        adoptLocalChapters(remoteDeck.id, chapters.filter((chapter) => !knownChapterIds.has(chapter.id)), report);
        adoptLocalCards(remoteDeck.id, cards.filter((card) => !knownCardIds.has(card.id)), cardChapter, report);
      }
      for (const card of Object.values(current.cards)) {
        if (card.deck_id !== remoteDeck.id || card.local || !card.cloud) continue;
        if (remoteCardIds.has(card.id)) continue;
        if (card.pending || card.conflict || hasPendingMove(card.id)) {
          if (!card.conflict) {
            const conflictId = addConflict({
              kind: 'card-remote-deleted',
              entity: 'card',
              deck_id: card.deck_id,
              chapter_id: card.chapter_id ?? null,
              card_id: card.id,
              base: card.cloud ? card.cloud.content : null,
              local: card.pending ? card.pending.content : card.content,
              remote: null,
            });
            card.conflict = conflictId;
            report.conflicts += 1;
          }
        } else {
          detachCardId(card.id);
          delete current.cards[card.id];
          report.cards_deleted += 1;
        }
      }
      applyLocalRouting(remoteDeck.id);
      const deck = current.decks[remoteDeck.id];
      if (deck) {
        deck.chapterset_revision = chapterset && chapterset.revision !== undefined ? chapterset.revision : deck.chapterset_revision;
        const localChapters = Object.values(current.chapters)
          .filter((chapter) => chapter.deck_id === remoteDeck.id && chapter.local)
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
        deck.chapter_ids = dedupe([...chapterIds, ...localChapters.map((chapter) => chapter.id)]);
        deck.pulled_at = clock();
        report.decks += 1;
        decksDone += 1;
        emit({
          stage: 'pull',
          phase: 'deck',
          decks_done: decksDone,
          decks_total: targets.length,
          deck_name: remoteDeck.name,
          chapters: report.chapters,
          cards: report.cards,
          cards_deleted: report.cards_deleted,
          adopted_cards: report.adopted_cards,
          adopted_chapters: report.adopted_chapters,
          conflicts: report.conflicts,
        });
      }
    }
    emit({ stage: 'pull', phase: 'done', pull: report });
    current.meta.last_pull_at = clock();
    if (full) current.meta.last_full_pull_at = clock();
    current.meta.last_error = null;
    lastReadError = null;
    await store.saveNow();
    return report;
  }
  function adoptLocalChapters(deckId, candidateChapters, report) {
    const current = cache();
    const used = new Set();
    const locals = Object.values(current.chapters).filter(
      (chapter) => chapter.deck_id === deckId && chapter.local === true && chapter.pending && chapter.pending.op === 'create',
    );
    for (const localChapter of locals) {
      const matches = candidateChapters.filter((chapter) => !used.has(chapter.id) && chapter.name === localChapter.pending.name);
      if (matches.length !== 1) continue;
      const remote = matches[0];
      used.add(remote.id);
      remapChapterId(localChapter.id, remote, undefined);
      report.adopted_chapters += 1;
      log('info', 'resume: adopted already-created chapter ' + localChapter.id + ' -> ' + remote.id);
    }
  }
  function adoptLocalCards(deckId, candidateCards, cardChapter, report) {
    const current = cache();
    const used = new Set();
    const locals = Object.values(current.cards).filter(
      (card) => card.deck_id === deckId && card.local === true && !card.conflict,
    );
    for (const localCard of locals) {
      const matches = candidateCards.filter(
        (card) =>
          !used.has(card.id) &&
          (card.content ?? '') === localCard.content &&
          (cardChapter.get(card.id) ?? null) === localCard.chapter_id,
      );
      if (matches.length !== 1) continue;
      const remote = matches[0];
      used.add(remote.id);
      const remoteRecord = current.cards[remote.id];
      if (!remoteRecord) continue;
      const realId = remote.id;
      delete current.cards[localCard.id];
      remoteRecord.pending = null;
      remoteRecord.conflict = null;
      remoteRecord.content = localCard.content;
      remoteRecord.grammar_version = localCard.grammar_version ?? remoteRecord.grammar_version;
      for (const chapter of Object.values(current.chapters)) {
        if (!Array.isArray(chapter.card_ids)) continue;
        chapter.card_ids = dedupe(chapter.card_ids.map((id) => (id === localCard.id ? realId : id)));
      }
      for (const move of current.moves) {
        move.card_ids = dedupe(move.card_ids.map((id) => (id === localCard.id ? realId : id)));
      }
      for (const conflict of current.conflicts) {
        if (conflict.card_id === localCard.id) conflict.card_id = realId;
      }
      report.adopted_cards += 1;
      log('info', 'resume: adopted already-created card ' + localCard.id + ' -> ' + realId);
    }
  }
  function chapterHasLocalWork(chapterId) {
    return Object.values(cache().cards).some(
      (card) => card.chapter_id === chapterId && (card.local || card.pending || card.conflict),
    );
  }

  // ---------------------------------------------------------------- push ----

  function insertCardId(chapterId, cardId, at) {
    const chapter = cache().chapters[chapterId];
    if (!chapter) return;
    if (!Array.isArray(chapter.card_ids)) chapter.card_ids = [];
    if (chapter.card_ids.includes(cardId)) return;
    if (Number.isInteger(at)) {
      const index = Math.max(0, Math.min(at, chapter.card_ids.length));
      chapter.card_ids.splice(index, 0, cardId);
    } else {
      chapter.card_ids.push(cardId);
    }
  }
  function removeCardId(chapterId, cardId) {
    const chapter = cache().chapters[chapterId];
    if (!chapter || !Array.isArray(chapter.card_ids)) return;
    chapter.card_ids = chapter.card_ids.filter((id) => id !== cardId);
  }
  function remapChapterId(localId, providerChapter, chaptersetRevision) {
    const current = cache();
    const previous = current.chapters[localId];
    if (!previous) return;
    delete current.chapters[localId];
    const realId = providerChapter.id;
    const inheritedCardIds = (previous.card_ids ?? []).filter((id) => {
      const card = current.cards[id];
      return card && card.local === true;
    });
    current.chapters[realId] = {
      id: realId,
      deck_id: previous.deck_id,
      name: providerChapter.name ?? previous.name,
      revision: providerChapter.revision ?? null,
      updated_time: providerChapter.updated_time ?? null,
      order: previous.order ?? 0,
      card_ids: dedupe([...(providerChapter.card_ids ?? []), ...inheritedCardIds]),
      pulled_at: clock(),
    };
    for (const card of Object.values(current.cards)) {
      if (card.chapter_id === localId) card.chapter_id = realId;
    }
    for (const move of current.moves) {
      if (move.from_chapter_id === localId) move.from_chapter_id = realId;
      if (move.to_chapter_id === localId) move.to_chapter_id = realId;
    }
    const deck = current.decks[previous.deck_id];
    if (deck) {
      deck.chapter_ids = dedupe((deck.chapter_ids ?? []).map((id) => (id === localId ? realId : id)));
      if (!deck.chapter_ids.includes(realId)) deck.chapter_ids.push(realId);
      if (deck.pending_sort) {
        deck.pending_sort.chapter_ids = deck.pending_sort.chapter_ids.map((id) => (id === localId ? realId : id));
      }
      if (chaptersetRevision !== undefined && chaptersetRevision !== null) deck.chapterset_revision = chaptersetRevision;
    }
    for (const conflict of current.conflicts) {
      if (conflict.chapter_id === localId) conflict.chapter_id = realId;
    }
  }
  function rekeyCard(previous, providerCard, chapterId) {
    const current = cache();
    delete current.cards[previous.id];
    const snapshot = {
      revision: providerCard.revision ?? 0,
      content: providerCard.content ?? previous.content,
      grammar_version: providerCard.grammar_version ?? previous.grammar_version,
      content_type: providerCard.content_type ?? null,
      updated_time: providerCard.updated_time ?? null,
      chapter_id: chapterId,
      status: providerCard.status ?? 'NORMAL',
    };
    current.cards[providerCard.id] = {
      id: providerCard.id,
      deck_id: previous.deck_id,
      chapter_id: chapterId,
      content: snapshot.content,
      grammar_version: snapshot.grammar_version,
      cloud: snapshot,
      pending: null,
      conflict: previous.conflict ?? null,
      created_time: providerCard.created_time ?? previous.created_time ?? null,
      updated_time: snapshot.updated_time,
      pulled_at: clock(),
    };
    for (const chapter of Object.values(current.chapters)) {
      if (!Array.isArray(chapter.card_ids)) continue;
      if (chapter.card_ids.includes(previous.id)) {
        chapter.card_ids = dedupe(chapter.card_ids.map((id) => (id === previous.id ? providerCard.id : id)));
      }
    }
    for (const move of current.moves) {
      move.card_ids = dedupe(move.card_ids.map((id) => (id === previous.id ? providerCard.id : id)));
    }
    for (const conflict of current.conflicts) {
      if (conflict.card_id === previous.id) conflict.card_id = providerCard.id;
    }
  }
  function recordChapterConflict(chapter, op, remoteValue) {
    const pending = chapter.pending;
    return addConflict({
      kind: 'chapter-revision',
      entity: 'chapter',
      deck_id: chapter.deck_id,
      chapter_id: chapter.id,
      local: pending ? pending.name : null,
      remote: remoteValue ?? null,
      op,
    });
  }
  function syntaxErrorFor(card, validation) {
    const first = validation.errors[0] ?? { message: 'unknown syntax error', line: null, column: null };
    const at = Number.isInteger(first.line) ? ' at line ' + first.line + ':' + first.column : '';
    const error = fail('invalid_card_content', 'card ' + card.id + ' has invalid Markji syntax' + at + ': ' + first.message);
    error.card_id = card.id;
    error.errors = validation.errors.slice(0, 20);
    error.warnings = validation.warnings.slice(0, 20);
    if (typeof first.hint === 'string' && first.hint !== '') error.hint = first.hint;
    return error;
  }

  function mediaErrorFor(cardId, missing) {
    const labels = missing.map((ref) => ref.kind + ' ' + ref.id).join(', ');
    const error = fail(
      'media_unavailable',
      'card ' + cardId + ' references media that Markji could not find: ' + labels,
      'upload the file with markji_file, then update the card content with the returned file.id',
    );
    error.card_id = cardId;
    error.media = missing.map((ref) => ({ kind: ref.kind, id: ref.id }));
    return error;
  }

  /**
   * Preflight the queued card writes before any card reaches the provider.
   * The syntax and media-reference logic is shared with the write-time preflight
   * in lib/preflight.js; this final gate stays even when checkMediaOnWrite=false
   * or when the referenced upload was deleted after the edit was queued.
   * A card that fails either check stays queued and is reported, never half-written.
   */
  async function preflightPushCards(cards) {
    const failures = new Map();
    if (cards.length === 0) return failures;
    const mediaByCard = new Map();
    const mediaIds = new Set();
    for (const card of cards) {
      const content = card.pending ? card.pending.content : card.content;
      const validation = await preflightContent(content);
      if (!validation.ok) {
        failures.set(card.id, syntaxErrorFor(card, validation));
        continue;
      }
      const refs = validation.media;
      if (refs.length > 0) {
        for (const ref of refs) mediaIds.add(ref.id);
        mediaByCard.set(card.id, refs);
      }
    }
    if (mediaIds.size === 0) return failures;
    let available;
    try {
      available = await queryAvailableMedia(client, mediaIds);
    } catch (error) {
      for (const [cardId, refs] of mediaByCard) {
        const failure = fail(
          'media_check_failed',
          'card ' + cardId + ' media availability could not be checked: ' + errMessage(error),
          'retry markji_sync; queued edits were kept',
        );
        failure.card_id = cardId;
        failure.media = refs.map((ref) => ({ kind: ref.kind, id: ref.id }));
        failures.set(cardId, failure);
      }
      return failures;
    }
    for (const [cardId, refs] of mediaByCard) {
      const missing = missingMedia(refs, available);
      if (missing.length > 0) failures.set(cardId, mediaErrorFor(cardId, missing));
    }
    return failures;
  }

  async function pushInternal(options = {}) {
    const signal = options.signal;
    const check = () => {
      if (signal !== undefined && signal.aborted) throw new Error('sync task cancelled');
    };
    await ready();
    check();
    const current = cache();
    const report = {
      chapters_created: 0,
      chapters_renamed: 0,
      chapters_sorted: 0,
      cards_created: 0,
      cards_updated: 0,
      cards_moved: 0,
      conflicts: 0,
      errors: [],
    };
    const emit = typeof options.onEvent === 'function' ? options.onEvent : () => {};
    const snapshot = () => ({
      chapters_created: report.chapters_created,
      chapters_renamed: report.chapters_renamed,
      chapters_sorted: report.chapters_sorted,
      cards_created: report.cards_created,
      cards_updated: report.cards_updated,
      cards_moved: report.cards_moved,
      conflicts_created: report.conflicts,
      errors: report.errors.length,
    });

    const chapterCreates = Object.values(current.chapters)
      .filter((chapter) => chapter.pending && chapter.pending.op === 'create')
      .sort((a, b) => (a.pending.order ?? 1e9) - (b.pending.order ?? 1e9) || String(a.created_time).localeCompare(String(b.created_time)));
    emit({ stage: 'push', phase: 'stage', stage_name: 'chapters_create', total: chapterCreates.length });
    for (let chapterIndex = 0; chapterIndex < chapterCreates.length; chapterIndex += 1) {
      check();
      const chapter = chapterCreates[chapterIndex];
      const chapterDeck = current.decks[chapter.deck_id];
      if (chapterDeck && chapterDeck.missing) continue;
      try {
        const result = await client.createChapter({
          deck: chapter.deck_id,
          name: chapter.pending.name,
          ...(Number.isInteger(chapter.pending.order) ? { order: chapter.pending.order } : {}),
        });
        if (!result || !result.chapter) throw fail('bad_response', 'createChapter returned no chapter');
        remapChapterId(chapter.id, result.chapter, result.chapterset ? result.chapterset.revision : undefined);
        report.chapters_created += 1;
      } catch (error) {
        report.errors.push(errorInfo('chapter_create', chapter.id, error));
      }
      emit({ stage: 'push', phase: 'item', stage_name: 'chapters_create', done: chapterIndex + 1, total: chapterCreates.length, counters: snapshot() });
    }

    const chapterRenames = Object.values(current.chapters).filter(
      (chapter) => chapter.pending && chapter.pending.op === 'rename',
    );
    emit({ stage: 'push', phase: 'stage', stage_name: 'chapters_rename', total: chapterRenames.length });
    for (let renameIndex = 0; renameIndex < chapterRenames.length; renameIndex += 1) {
      check();
      const chapter = chapterRenames[renameIndex];
      try {
        const updated = await client.updateChapter({
          deck: chapter.deck_id,
          chapter: chapter.id,
          name: chapter.pending.name,
          revision: chapter.pending.base_revision ?? chapter.revision,
        });
        chapter.name = updated.name ?? chapter.pending.name;
        chapter.revision = updated.revision ?? chapter.revision;
        chapter.updated_time = updated.updated_time ?? chapter.updated_time;
        chapter.pending = null;
        report.chapters_renamed += 1;
      } catch (error) {
        let remoteName = null;
        try {
          const refreshed = await client.getChapter(chapter.deck_id, chapter.id);
          if (refreshed && refreshed.chapter) {
            remoteName = refreshed.chapter.name ?? null;
            chapter.revision = refreshed.chapter.revision ?? chapter.revision;
            chapter.updated_time = refreshed.chapter.updated_time ?? chapter.updated_time;
          }
        } catch {
          /* keep the conflict record without the remote name */
        }
        recordChapterConflict(chapter, 'rename', remoteName);
        report.conflicts += 1;
        report.errors.push(errorInfo('chapter_rename', chapter.id, error));
      }
      emit({ stage: 'push', phase: 'item', stage_name: 'chapters_rename', done: renameIndex + 1, total: chapterRenames.length, counters: snapshot() });
    }

    const sorts = Object.values(current.decks).filter((deck) => deck.pending_sort);
    emit({ stage: 'push', phase: 'stage', stage_name: 'chapters_sort', total: sorts.length });
    for (let sortIndex = 0; sortIndex < sorts.length; sortIndex += 1) {
      check();
      const deck = sorts[sortIndex];
      try {
        const result = await client.sortChapters({
          deck: deck.id,
          chapter_ids: deck.pending_sort.chapter_ids,
          revision: deck.pending_sort.base_revision,
        });
        if (result && result.revision !== undefined) deck.chapterset_revision = result.revision;
        else if (result) deck.chapterset_revision = result.revision ?? deck.chapterset_revision;
        deck.chapter_ids = deck.pending_sort.chapter_ids.slice();
        deck.chapter_ids.forEach((id, index) => {
          if (current.chapters[id]) current.chapters[id].order = index;
        });
        deck.pending_sort = null;
        report.chapters_sorted += 1;
      } catch (error) {
        addConflict({
          kind: 'chapter-revision',
          entity: 'chapter',
          deck_id: deck.id,
          chapter_id: null,
          local: deck.pending_sort.chapter_ids.join(','),
          remote: null,
          op: 'sort',
        });
        report.conflicts += 1;
        report.errors.push(errorInfo('chapter_sort', deck.id, error));
      }
      emit({ stage: 'push', phase: 'item', stage_name: 'chapters_sort', done: sortIndex + 1, total: sorts.length, counters: snapshot() });
    }

    const cardCreates = Object.values(current.cards)
      .filter((card) => card.local === true && !card.conflict)
      .sort((a, b) => String(a.created_time).localeCompare(String(b.created_time)) || a.id.localeCompare(b.id));
    const cardUpdates = Object.values(current.cards).filter(
      (card) => card.pending && !card.local && !card.conflict,
    );
    const pendingCards = [...cardCreates, ...cardUpdates];
    check();
    const preflightFailures = await preflightPushCards(pendingCards);
    check();
    for (const card of pendingCards) {
      const failure = preflightFailures.get(card.id);
      if (!failure) continue;
      const op = card.local ? 'card_create' : 'card_update';
      setCardError(card, op, failure);
      report.errors.push(errorInfo(op, card.id, failure));
    }
    const validCardCreates = cardCreates.filter((card) => !preflightFailures.has(card.id));
    const validCardUpdates = cardUpdates.filter((card) => !preflightFailures.has(card.id));
    emit({ stage: 'push', phase: 'stage', stage_name: 'cards_create', total: validCardCreates.length });
    for (let createIndex = 0; createIndex < validCardCreates.length; createIndex += 1) {
      check();
      const card = validCardCreates[createIndex];
      const cardDeck = current.decks[card.deck_id];
      if (cardDeck && cardDeck.missing) {
        setCardError(card, 'card_create', { code: 'deck_missing', message: 'the target deck is missing from the cloud' });
        continue;
      }
      const chapter = current.chapters[card.chapter_id];
      if (!chapter || chapter.local) {
        const detail = {
          code: 'chapter_missing',
          message: 'the target chapter has not been created on the cloud yet',
        };
        setCardError(card, 'card_create', detail);
        report.errors.push({ op: 'card_create', id: card.id, ...detail });
        continue;
      }
      if (chapter.missing) {
        setCardError(card, 'card_create', { code: 'chapter_missing', message: 'the target chapter is missing from the cloud' });
        continue;
      }
      try {
        const result = await client.createCard({
          deck: card.deck_id,
          chapter: chapter.id,
          card: {
            content: card.pending ? card.pending.content : card.content,
            grammar_version: card.grammar_version ?? config.grammarVersion,
          },
          ...(Number.isInteger(card.order) ? { order: card.order } : {}),
        });
        if (!result || !result.card) throw fail('bad_response', 'createCard returned no card');
        rekeyCard(card, result.card, chapter.id);
        clearCardError(card);
        if (result.chapter && result.chapter.card_ids) {
          const stored = current.chapters[chapter.id];
          if (stored) stored.card_ids = result.chapter.card_ids.slice();
        }
        report.cards_created += 1;
      } catch (error) {
        setCardError(card, 'card_create', error);
        report.errors.push(errorInfo('card_create', card.id, error));
      }
      emit({ stage: 'push', phase: 'item', stage_name: 'cards_create', done: createIndex + 1, total: validCardCreates.length, counters: snapshot() });
    }

    emit({ stage: 'push', phase: 'stage', stage_name: 'cards_update', total: validCardUpdates.length });
    for (let updateIndex = 0; updateIndex < validCardUpdates.length; updateIndex += 1) {
      check();
      const card = validCardUpdates[updateIndex];
      const updateDeck = current.decks[card.deck_id];
      const updateChapter = current.chapters[card.chapter_id];
      if (updateDeck && updateDeck.missing) {
        setCardError(card, 'card_update', { code: 'deck_missing', message: 'the target deck is missing from the cloud' });
        continue;
      }
      if (updateChapter && updateChapter.missing) {
        setCardError(card, 'card_update', { code: 'chapter_missing', message: 'the target chapter is missing from the cloud' });
        continue;
      }
      try {
        const grammar = card.pending.grammar_version ?? (card.cloud ? card.cloud.grammar_version : null) ?? card.grammar_version ?? config.grammarVersion;
        const updated = await client.updateCard({
          deck_id: card.deck_id,
          card_id: card.id,
          card: { content: card.pending.content, grammar_version: grammar },
        });
        card.content = card.pending.content;
        card.grammar_version = updated.grammar_version ?? grammar;
        card.pending = null;
        card.cloud = {
          revision: updated.revision ?? (card.cloud ? card.cloud.revision : 0),
          content: updated.content ?? card.content,
          grammar_version: updated.grammar_version ?? grammar,
          content_type: updated.content_type ?? (card.cloud ? card.cloud.content_type : null),
          updated_time: updated.updated_time ?? card.updated_time,
          chapter_id: card.chapter_id,
          status: updated.status ?? 'NORMAL',
        };
        card.updated_time = updated.updated_time ?? card.updated_time;
        clearCardError(card, 'card_update');
        report.cards_updated += 1;
      } catch (error) {
        setCardError(card, 'card_update', error);
        report.errors.push(errorInfo('card_update', card.id, error));
      }
      emit({ stage: 'push', phase: 'item', stage_name: 'cards_update', done: updateIndex + 1, total: validCardUpdates.length, counters: snapshot() });
    }

    emit({ stage: 'push', phase: 'stage', stage_name: 'cards_move', total: current.moves.length });
    for (const move of current.moves.slice()) {
      check();
      // Do not move a card whose content preflight failed: content and placement
      // must not land separately, and the card stays queued with its error.
      if (move.card_ids.some((id) => preflightFailures.has(id))) continue;
      const realIds = move.card_ids.filter((id) => {
        const card = current.cards[id];
        return card && card.local !== true;
      });
      if (realIds.length === 0) {
        current.moves = current.moves.filter((entry) => entry.id !== move.id);
        continue;
      }
      const moveDeck = current.decks[move.deck_id];
      if (moveDeck && moveDeck.missing) {
        for (const id of realIds) setCardError(current.cards[id], 'cards_move', { code: 'deck_missing', message: 'the target deck is missing from the cloud' });
        continue;
      }
      const from = current.chapters[move.from_chapter_id];
      const to = current.chapters[move.to_chapter_id];
      if (!from || from.local || from.missing || !to || to.local || to.missing) {
        const detail = {
          code: 'chapter_missing',
          message: 'the source or target chapter is not available on the cloud yet',
        };
        for (const id of realIds) setCardError(current.cards[id], 'cards_move', detail);
        report.errors.push({ op: 'cards_move', id: move.id, ...detail });
        continue;
      }
      try {
        const result = await client.moveCards({
          deck: move.deck_id,
          chapter: from.id,
          card_ids: realIds,
          to_chapter_id: to.id,
          ...(Number.isInteger(move.order) ? { order: move.order } : {}),
        });
        for (const chapter of [result.old_chapter, result.new_chapter]) {
          if (!chapter || typeof chapter.id !== 'string') continue;
          const stored = current.chapters[chapter.id];
          if (stored) {
            stored.card_ids = Array.isArray(chapter.card_ids) ? chapter.card_ids.slice() : stored.card_ids;
            stored.revision = chapter.revision ?? stored.revision;
            stored.updated_time = chapter.updated_time ?? stored.updated_time;
          }
        }
        for (const cardId of realIds) {
          const card = current.cards[cardId];
          if (!card) continue;
          card.chapter_id = to.id;
          if (card.cloud) card.cloud.chapter_id = to.id;
          clearCardError(card, 'cards_move');
        }
        current.moves = current.moves.filter((entry) => entry.id !== move.id);
        report.cards_moved += realIds.length;
      } catch (error) {
        for (const id of realIds) setCardError(current.cards[id], 'cards_move', error);
        report.errors.push(errorInfo('cards_move', move.id, error));
      }
    }

    emit({ stage: 'push', phase: 'done', push: report, counters: snapshot() });
    current.meta.last_push_at = clock();
    if (report.errors.length === 0) current.meta.last_error = null;
    await store.saveNow();
    return report;
  }

  // -------------------------------------------------------------- reads ----

  async function ensureFresh(maxAgeMs) {
    await ready();
    lastReadError = null;
    if (client.configured === false) return;
    const last = cache().meta.last_pull_at;
    if (maxAgeMs > 0 && last !== null && last !== undefined && clock() - last <= maxAgeMs) return;
    try {
      await withLock(() =>
        store.withWriteLock(
          async () => {
            syncing = true;
            try {
              await store.refreshIfChanged();
              return await pullInternal({ full: false, reason: 'read' });
            } finally {
              syncing = false;
            }
          },
          { timeoutMs: 120000 },
        ),
      );
    } catch (error) {
      lastReadError = errMessage(error);
      log('warn', 'lazy pull failed: ' + lastReadError);
    }
  }
  /**
   * Cheap refresh used before an id is reported as unknown. Only decks the
   * provider marks as changed are fetched: a full pull of a large account takes
   * minutes, and a typo id must fail fast. Callers that really need a complete
   * refresh should run markji_sync with full=true.
   */
  async function forcePullForMissing(reason) {
    if (syncing) {
      log('debug', 'skip ' + reason + ' refresh: a sync is already running');
      return;
    }
    try {
      await withLock(() =>
        store.withWriteLock(
          async () => {
            syncing = true;
            try {
              await store.refreshIfChanged();
              return await pullInternal({ full: false, reason });
            } finally {
              syncing = false;
            }
          },
          { timeoutMs: 20000 },
        ),
      );
    } catch (error) {
      log('warn', 'refresh pull failed: ' + errMessage(error));
    }
  }

  async function listDecks(args = {}) {
    touch();
    await ready();
    await ensureFresh(args.refresh === true ? 0 : config.pullTtlMs);
    const current = cache();
    const folderId = typeof args.folder_id === 'string' && args.folder_id !== '' ? args.folder_id : null;
    const scope = readScope(args, 'markji_decks', ['all', 'folder']) ?? (folderId === null ? 'all' : 'folder');
    if (scope === 'all' && folderId !== null) {
      throw fail('invalid_argument', 'markji_decks: scope=all cannot be combined with folder_id');
    }
    if (scope === 'folder' && folderId === null) {
      throw fail('invalid_argument', 'markji_decks: scope=folder requires folder_id');
    }
    const folders = Object.values(current.folders);
    const folderOfDeck = new Map();
    for (const folder of folders) {
      for (const item of folder.items) {
        if (item.object_class === 'DECK') folderOfDeck.set(item.object_id, folder.id);
      }
    }
    let decks = Object.values(current.decks);
    if (folderId !== null) {
      const folder = current.folders[folderId];
      if (!folder) throw fail('unknown_folder', 'Unknown folder: ' + folderId + ' is not in the local cache', 'call markji_sync with full=true first');
      const ids = new Set(folder.items.filter((item) => item.object_class === 'DECK').map((item) => item.object_id));
      decks = decks.filter((deck) => ids.has(deck.id));
    }
    const filter = compileDeckFilter(args);
    const rows = decks.map((deck) => {
      const folder_id = folderOfDeck.get(deck.id);
      return {
        values: { ...deck, folder_id, chapter_count: deck.chapter_count ?? 0 },
        view: deckView(deck, { folder_id }),
      };
    });
    const filtered = filterRows(rows, filter);
    const result = {
      folders: folders.map((folder) => {
        const view = {
          id: folder.id,
          name: folder.name,
          deck_count: folder.items.filter((item) => item.object_class === 'DECK').length,
        };
        if (folder.parent_id) view.parent_id = folder.parent_id;
        return view;
      }),
      decks: filtered,
      total: filtered.length,
    };
    if (filtered.length === 0 && filter.filter !== null) result.hint = 'No deck matched this filter.';
    return result;
  }
  async function listChapters(args = {}) {
    touch();
    await ready();
    await ensureFresh(args.refresh === true ? 0 : config.pullTtlMs);
    const current = cache();
    const deckId = typeof args.deck === 'string' && args.deck !== '' ? args.deck : null;
    const scope = readScope(args, 'markji_chapters', ['all', 'deck']) ?? (deckId === null ? 'all' : 'deck');
    if (scope === 'all' && deckId !== null) {
      throw fail('invalid_argument', 'markji_chapters: scope=all cannot be combined with deck');
    }
    if (scope === 'deck' && deckId === null) {
      throw fail('invalid_argument', 'markji_chapters: scope=deck requires deck');
    }
    const filter = compileChapterFilter(args);
    const rowsFor = (deck) =>
      Object.values(current.chapters)
        .filter((chapter) => chapter.deck_id === deck.id)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)))
        .map((chapter) => ({
          values: { ...chapter, card_count: Array.isArray(chapter.card_ids) ? chapter.card_ids.length : 0 },
          view: chapterView(chapter),
        }));
    const active = filter.filter !== null;
    if (deckId !== null) {
      let deck = current.decks[deckId];
      if (!deck) {
        await forcePullForMissing('chapters');
        deck = current.decks[deckId];
        if (!deck) {
          throw fail('unknown_deck', 'Unknown deck: ' + deckId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
        }
      }
      const chapters = filterRows(rowsFor(deck), filter);
      const result = { deck_id: deck.id, deck_name: deck.name, chapters, total: chapters.length };
      if (chapters.length === 0 && filter.filter !== null) result.hint = 'No chapter matched this filter.';
      return result;
    }
    const decks = [];
    let total = 0;
    for (const deck of Object.values(current.decks)) {
      const chapters = filterRows(rowsFor(deck), filter);
      total += chapters.length;
      if (active && chapters.length === 0) continue;
      decks.push({ deck_id: deck.id, deck_name: deck.name, chapters });
    }
    const result = { decks, total };
    if (total === 0 && filter.filter !== null) result.hint = 'No chapter matched this filter.';
    return result;
  }
  async function getDeck(args = {}) {
    touch();
    await ready();
    const deckId = typeof args.deck === 'string' ? args.deck : '';
    if (deckId === '') throw fail('invalid_argument', 'deck id is required');
    await ensureFresh(args.refresh === true ? 0 : config.pullTtlMs);
    let current = cache();
    if (!current.decks[deckId]) {
      await forcePullForMissing('deck');
      current = cache();
    }
    const deck = current.decks[deckId];
    if (!deck) throw fail('unknown_deck', 'Unknown deck: ' + deckId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
    const chapters = Object.values(current.chapters)
      .filter((chapter) => chapter.deck_id === deckId)
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name)))
      .map((chapter) => chapterView(chapter, true));
    return { deck: deckView(deck, { detail: true }), chapters };
  }

  async function getChapter(args = {}) {
    touch();
    await ready();
    const chapterId = typeof args.chapter === 'string' ? args.chapter : '';
    if (chapterId === '') throw fail('invalid_argument', 'chapter id is required');
    const requestedDeck = typeof args.deck === 'string' ? args.deck : '';
    await ensureFresh(args.refresh === true ? 0 : config.pullTtlMs);
    let current = cache();
    let chapter = current.chapters[chapterId];
    if (!chapter) {
      await forcePullForMissing('chapter');
      current = cache();
      chapter = current.chapters[chapterId];
    }
    if (!chapter) throw fail('unknown_chapter', 'Unknown chapter: ' + chapterId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
    if (requestedDeck !== '' && chapter.deck_id !== requestedDeck) {
      throw fail('unknown_chapter', 'Chapter ' + chapterId + ' does not belong to deck ' + requestedDeck, 'call markji_decks action=chapter_list to list chapters');
    }
    let deck = current.decks[chapter.deck_id];
    if (!deck) {
      await forcePullForMissing('chapter');
      current = cache();
      deck = current.decks[chapter.deck_id];
    }
    if (!deck) throw fail('unknown_deck', 'Unknown deck: ' + chapter.deck_id + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
    const result = {
      deck_id: chapter.deck_id,
      deck_name: deck.name,
      chapter: chapterView(chapter, true),
    };
    if (args.with_cards === true) {
      const cards = orderedCards().filter((card) => card.chapter_id === chapterId).map(cardSummary);
      result.cards = cards;
      result.total = cards.length;
    }
    return result;
  }

  /** Fields exposed to filter trees for one card. */
  function cardFilterValues(card) {
    const current = cache();
    const deck = current.decks[card.deck_id];
    const chapter = current.chapters[card.chapter_id];
    const text = plainText(card.content);
    const cloud = isObject(card.cloud) ? card.cloud : null;
    return {
      id: card.id,
      deck_id: card.deck_id,
      deck_name: deck ? deck.name : null,
      chapter_id: card.chapter_id ?? null,
      chapter_name: chapter ? chapter.name : null,
      status: cardStatus(card),
      text,
      content: card.content,
      snippet: snippet(text),
      grammar_version: card.grammar_version ?? null,
      revision: cloud ? cloud.revision ?? null : null,
      updated_time: cloud && cloud.updated_time !== undefined && cloud.updated_time !== null ? cloud.updated_time : card.updated_time ?? null,
      created_time: cloud && cloud.created_time !== undefined && cloud.created_time !== null ? cloud.created_time : card.created_time ?? null,
      local: card.local === true,
      pending: card.pending ?? null,
      conflict: card.conflict ?? null,
      last_error: card.last_error ?? null,
      cloud,
    };
  }

  async function listCards(args = {}) {
    touch();
    await ready();
    await ensureFresh(args.refresh === true ? 0 : config.pullTtlMs);
    const current = cache();
    const deckId = typeof args.deck === 'string' && args.deck !== '' ? args.deck : null;
    const chapterId = typeof args.chapter === 'string' && args.chapter !== '' ? args.chapter : null;
    const scope = readScope(args, 'markji_cards', ['all', 'deck', 'chapter']) ?? (chapterId !== null ? 'chapter' : deckId !== null ? 'deck' : 'all');
    if (scope === 'all' && (deckId !== null || chapterId !== null)) {
      throw fail('invalid_argument', 'markji_cards: scope=all cannot be combined with deck or chapter');
    }
    if (scope === 'deck' && deckId === null) {
      throw fail('invalid_argument', 'markji_cards: scope=deck requires deck');
    }
    if (scope === 'chapter' && chapterId === null) {
      throw fail('invalid_argument', 'markji_cards: scope=chapter requires chapter');
    }
    if (deckId !== null && !current.decks[deckId]) {
      throw fail('unknown_deck', 'Unknown deck: ' + deckId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
    }
    if (chapterId !== null && !current.chapters[chapterId]) {
      throw fail('unknown_chapter', 'Unknown chapter: ' + chapterId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
    }
    if (chapterId !== null && deckId !== null && current.chapters[chapterId].deck_id !== deckId) {
      throw fail('unknown_chapter', 'Chapter ' + chapterId + ' does not belong to deck ' + deckId, 'call markji_decks action=chapter_list to list chapters');
    }
    const deckName = typeof args.deck_name === 'string' && args.deck_name.trim() !== '' ? args.deck_name.trim().toLowerCase() : null;
    const chapterName = typeof args.chapter_name === 'string' && args.chapter_name.trim() !== '' ? args.chapter_name.trim().toLowerCase() : null;
    const updatedAfter = timeOption(args.updated_after, 'updated_after');
    const updatedBefore = timeOption(args.updated_before, 'updated_before');
    if (updatedAfter !== null && updatedBefore !== null && updatedAfter > updatedBefore) {
      throw fail('invalid_argument', 'updated_after must not be later than updated_before');
    }
    const limit = numberOption(args.limit, 50, 1, 200);
    const offset = numberOption(args.offset, 0, 0, 1e9);
    let candidates = orderedCards();
    if (deckId !== null) candidates = candidates.filter((card) => card.deck_id === deckId);
    if (chapterId !== null) candidates = candidates.filter((card) => card.chapter_id === chapterId);
    if (deckName !== null || chapterName !== null) {
      candidates = candidates.filter((card) => {
        const deck = current.decks[card.deck_id];
        const chapter = current.chapters[card.chapter_id];
        if (deckName !== null && !(deck && String(deck.name).toLowerCase().includes(deckName))) return false;
        if (chapterName !== null && !(chapter && String(chapter.name).toLowerCase().includes(chapterName))) return false;
        return true;
      });
    }
    if (updatedAfter !== null || updatedBefore !== null) {
      candidates = candidates.filter((card) => {
        const raw = isObject(card.cloud) && card.cloud.updated_time !== undefined && card.cloud.updated_time !== null ? card.cloud.updated_time : card.updated_time;
        if (raw === undefined || raw === null) return false;
        const parsed = typeof raw === 'number' ? raw : Date.parse(String(raw));
        if (!Number.isFinite(parsed)) return false;
        if (updatedAfter !== null && parsed < updatedAfter) return false;
        if (updatedBefore !== null && parsed > updatedBefore) return false;
        return true;
      });
    }
    const filter = compileCardFilter(args);
    const cards = filterRows(
      candidates.map((card) => ({ values: cardFilterValues(card), view: cardSummary(card) })),
      filter,
    );
    const total = cards.length;
    const result = {
      total,
      offset,
      limit,
      has_more: offset + limit < total,
      cards: cards.slice(offset, offset + limit),
    };
    if (total === 0 && filter.filter !== null) result.hint = 'No card matched this filter.';
    return result;
  }
  async function getCard(args = {}) {
    touch();
    await ready();
    if (typeof args.card !== 'string' || args.card === '') throw fail('invalid_argument', 'card id is required');
    await ensureFresh(config.pullTtlMs);
    let card = cache().cards[args.card];
    if (!card) {
      await forcePullForMissing('card');
      card = cache().cards[args.card];
    }
    if (!card) {
      throw fail('unknown_card', 'Unknown card: ' + args.card + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
    }
    return { card: cardDetail(card) };
  }

  /**
   * Read many cards in one call. A missing id is reported per item instead of
   * failing the whole batch; a single cheap pull is attempted once when any id
   * is missing, never once per id.
   */
  async function getCards(args = {}) {
    touch();
    await ready();
    const requested = dedupe(Array.isArray(args.cards) ? args.cards : []);
    if (requested.length === 0) throw fail('invalid_argument', 'cards must contain at least one card id');
    await ensureFresh(config.pullTtlMs);
    let current = cache();
    if (requested.some((id) => !current.cards[id])) {
      await forcePullForMissing('cards');
      current = cache();
    }
    const cards = [];
    const missing = [];
    for (const id of requested) {
      const card = current.cards[id];
      if (card) cards.push(cardDetail(card));
      else missing.push(id);
    }
    return missing.length === 0 ? { cards } : { cards, missing };
  }

  // ------------------------------------------------------------- writes ----

  async function addCard(args = {}) {
    touch();
    await ready();
    const deckId = typeof args.deck === 'string' ? args.deck : '';
    const chapterId = typeof args.chapter === 'string' ? args.chapter : '';
    if (deckId === '') throw fail('invalid_argument', 'deck id is required');
    if (chapterId === '') throw fail('invalid_argument', 'chapter id is required');
    const content = normalizeContent(args.content, 'markji_cards action=create');
    const current = cache();
    if (!current.decks[deckId]) {
      await forcePullForMissing('create-card');
      if (!current.decks[deckId]) throw fail('unknown_deck', 'Unknown deck: ' + deckId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
    }
    const chapter = current.chapters[chapterId];
    if (!chapter || chapter.deck_id !== deckId) {
      throw fail('unknown_chapter', 'Chapter ' + chapterId + ' does not belong to deck ' + deckId, 'call markji_sync with mode=pull full=true first');
    }
    const grammar = Number.isInteger(args.grammar_version) ? args.grammar_version : config.grammarVersion;
    const id = makeLocalId('cd');
    const order = Number.isInteger(args.order) ? Math.max(0, args.order) : undefined;
    const record = {
      id,
      deck_id: deckId,
      chapter_id: chapterId,
      local: true,
      content,
      grammar_version: grammar,
      cloud: null,
      pending: { content, grammar_version: grammar },
      conflict: null,
      created_time: nowIso(clock),
      updated_time: nowIso(clock),
      pulled_at: 0,
    };
    if (order !== undefined) record.order = order;
    current.cards[id] = record;
    insertCardId(chapterId, id, order);
    await store.flush();
    return {
      ok: true,
      card_id: id,
      deck_id: deckId,
      chapter_id: chapterId,
      status: 'new',
      changed: true,
      pending: true,
      message: 'Card queued locally; call markji_sync to push it now, or let idle auto-sync create it.',
    };
  }
  async function editCard(args = {}) {
    touch();
    await ready();
    const cardId = typeof args.card === 'string' ? args.card : '';
    if (cardId === '') throw fail('invalid_argument', 'card id is required');
    const content = normalizeContent(args.content, 'markji_cards action=update');
    const current = cache();
    let card = current.cards[cardId];
    if (!card) {
      await forcePullForMissing('update-card');
      card = current.cards[cardId];
    }
    if (!card) throw fail('unknown_card', 'Unknown card: ' + cardId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
    if (card.conflict) {
      throw fail('conflict_open', 'Card ' + cardId + ' has an open conflict; resolve it with markji_sync action=resolve first', 'markji_sync action=resolve id=' + card.conflict);
    }
    const grammar = Number.isInteger(args.grammar_version)
      ? args.grammar_version
      : (card.cloud ? card.cloud.grammar_version : null) ?? card.grammar_version ?? config.grammarVersion;
    if (content === card.content && card.pending && grammar === card.grammar_version) {
      return { ok: true, card_id: cardId, status: cardStatus(card), changed: false, pending: cardStatus(card) !== 'synced', message: 'Content is unchanged.' };
    }
    if (!card.local && card.cloud && card.cloud.content === content && !card.pending) {
      const cloudGrammar = card.cloud.grammar_version ?? card.grammar_version;
      if (grammar === cloudGrammar) {
        card.content = content;
        card.grammar_version = grammar;
        return { ok: true, card_id: cardId, status: 'synced', changed: false, pending: false, message: 'Content and grammar_version are unchanged.' };
      }
      // Content matches, but a new grammar_version still has to be pushed.
    }
    card.pending = { content, grammar_version: grammar };
    card.content = content;
    card.grammar_version = grammar;
    card.updated_time = nowIso(clock);
    await store.flush();
    return {
      ok: true,
      card_id: cardId,
      status: cardStatus(card),
      changed: true,
      pending: true,
      message: 'Edit queued locally; call markji_sync to push it now, or let idle auto-sync push it.',
    };
  }
  async function moveCards(args = {}) {
    touch();
    await ready();
    const ids = Array.isArray(args.cards) ? dedupe(args.cards) : [];
    if (ids.length === 0) throw fail('invalid_argument', 'cards must contain at least one card id');
    const toChapterId = typeof args.to_chapter === 'string' ? args.to_chapter : '';
    if (toChapterId === '') throw fail('invalid_argument', 'to_chapter is required');
    const current = cache();
    let target = current.chapters[toChapterId];
    if (!target) {
      await forcePullForMissing('move');
      target = current.chapters[toChapterId];
    }
    if (!target) throw fail('unknown_chapter', 'Unknown chapter: ' + toChapterId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
    const deckId = typeof args.deck === 'string' && args.deck !== '' ? args.deck : target.deck_id;
    if (target.deck_id !== deckId) throw fail('deck_mismatch', 'Target chapter belongs to deck ' + target.deck_id + ', not ' + deckId);
    const baseOrder = Number.isInteger(args.order) ? Math.max(0, args.order) : undefined;
    const groups = new Map();
    const previousMoves = current.moves.slice();
    current.moves = [];
    for (const move of previousMoves) {
      move.card_ids = move.card_ids.filter((id) => !ids.includes(id));
      if (move.card_ids.length > 0) current.moves.push(move);
    }
    for (let index = 0; index < ids.length; index += 1) {
      const card = current.cards[ids[index]];
      if (!card) throw fail('unknown_card', 'Unknown card: ' + ids[index] + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
      if (card.deck_id !== deckId) throw fail('deck_mismatch', 'Card ' + ids[index] + ' belongs to deck ' + card.deck_id + ', not ' + deckId);
      const from = card.chapter_id;
      removeCardId(from, card.id);
      const at = baseOrder === undefined ? undefined : baseOrder + index;
      insertCardId(toChapterId, card.id, at);
      card.chapter_id = toChapterId;
      delete card.order;
      if (card.local) continue;
      if (!groups.has(from)) groups.set(from, []);
      groups.get(from).push(card.id);
    }
    for (const [from, cardIds] of groups) {
      if (isLocalId(from) || !current.chapters[from]) continue;
      // One pending move per (deck, from, to, order) batch: append card ids.
      const existing = current.moves.find((move) => move.deck_id === deckId && move.from_chapter_id === from && move.to_chapter_id === toChapterId && (move.order ?? null) === (baseOrder === undefined ? null : baseOrder));
      if (existing) {
        existing.card_ids = dedupe([...existing.card_ids, ...cardIds]);
        continue;
      }
      current.moves.push({
        id: 'move_' + randomUUID().replace(/-/g, '').slice(0, 12),
        deck_id: deckId,
        from_chapter_id: from,
        card_ids: cardIds,
        to_chapter_id: toChapterId,
        order: baseOrder === undefined ? null : baseOrder,
        created_at: clock(),
      });
    }
    await store.flush();
    return {
      ok: true,
      moved: ids.length,
      to_chapter_id: toChapterId,
      status: 'pending',
      pending: true,
      message: 'Move queued locally; call markji_sync to push it now, or let idle auto-sync push it.',
    };
  }
  function archiveNoticeText() {
    const day = nowIso(clock).slice(0, 10);
    return '\\[已归档 ' + day + '\\] 本卡片已归档，仅作历史保留，不再安排复习。';
  }
  function archivedContent(content) {
    if (typeof content !== 'string') return archiveNoticeText();
    if (content.trimStart().startsWith(ARCHIVE_MARKER)) return content;
    // Older releases wrote an unescaped [已归档 ...] notice; escape it in place so
    // the card can pass syntax validation without adding a second notice.
    const legacy = /^(\s*)\[已归档 ([^\]\n]+)\]/.exec(content);
    if (legacy) return legacy[1] + '\\[已归档 ' + legacy[2] + '\\]' + content.slice(legacy[0].length);
    return archiveNoticeText() + '\n\n' + content;
  }
  function ensureArchiveChapter(current, deckId) {
    const existing = Object.values(current.chapters).find(
      (chapter) => chapter && chapter.deck_id === deckId && !chapter.missing && chapter.name === ARCHIVE_CHAPTER_NAME,
    );
    if (existing) return existing;
    const deck = current.decks[deckId];
    if (!deck) throw fail('unknown_deck', 'Unknown deck: ' + deckId + ' is not in the local cache', 'call markji_sync mode=pull full=true first');
    const id = makeLocalId('ch');
    const record = {
      id,
      deck_id: deckId,
      name: ARCHIVE_CHAPTER_NAME,
      revision: null,
      updated_time: null,
      order: Object.keys(current.chapters).filter((key) => current.chapters[key].deck_id === deckId).length,
      card_ids: [],
      local: true,
      pending: { op: 'create', name: ARCHIVE_CHAPTER_NAME },
      pulled_at: 0,
    };
    current.chapters[id] = record;
    deck.chapter_ids = dedupe([...(deck.chapter_ids ?? []), id]);
    return record;
  }
  /**
   * Archive cards: move them into the deck's "归档" chapter and prepend a notice
   * to their content. Idempotent: already archived cards are left untouched.
   */
  async function archiveCards(args = {}) {
    touch();
    await ready();
    const current = cache();
    const ids = Array.isArray(args.cards) ? dedupe(args.cards) : [];
    if (ids.length === 0) throw fail('invalid_argument', 'cards must contain at least one card id');
    const cards = ids.map((id) => {
      const card = current.cards[id];
      if (!card) throw fail('unknown_card', 'Unknown card: ' + id + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
      if (card.conflict) throw fail('conflict_open', 'Card ' + id + ' has an open conflict; resolve it with markji_sync action=resolve before archiving', 'markji_sync action=resolve id=' + card.conflict);
      return card;
    });
    // Validate decks once, before mutating anything.
    const deckIds = dedupe(cards.map((card) => card.deck_id));
    for (const deckId of deckIds) {
      if (!current.decks[deckId]) throw fail('unknown_deck', 'Unknown deck: ' + deckId + ' is not in the local cache', 'call markji_sync mode=pull full=true first');
    }
    const plans = cards.map((card) => ({ card, nextContent: archivedContent(card.content) }));
    for (const plan of plans) {
      if (plan.nextContent.length > CONTENT_MAX) {
        throw fail('invalid_content', 'Archiving card ' + plan.card.id + ' would exceed ' + CONTENT_MAX + ' characters');
      }
    }
    const chapters = new Map();
    for (const deckId of deckIds) chapters.set(deckId, ensureArchiveChapter(current, deckId));
    let contentUpdated = 0;
    let alreadyArchived = 0;
    for (const plan of plans) {
      const card = plan.card;
      if (plan.nextContent === card.content) {
        alreadyArchived += 1;
      } else {
        const grammar = (card.cloud ? card.cloud.grammar_version : null) ?? card.grammar_version ?? config.grammarVersion;
        card.pending = { content: plan.nextContent, grammar_version: grammar };
        card.content = plan.nextContent;
        card.grammar_version = grammar;
        card.updated_time = nowIso(clock);
        contentUpdated += 1;
      }
    }
    const movesByDeck = new Map();
    for (const card of cards) {
      const target = chapters.get(card.deck_id);
      if (card.chapter_id === target.id) continue;
      if (!movesByDeck.has(card.deck_id)) movesByDeck.set(card.deck_id, []);
      movesByDeck.get(card.deck_id).push(card.id);
    }
    let moved = 0;
    for (const [deckId, cardIds] of movesByDeck) {
      const target = chapters.get(deckId);
      const result = await moveCards({ cards: cardIds, to_chapter: target.id, deck: deckId });
      moved += result.moved;
    }
    await store.flush();
    return {
      ok: true,
      archived: cards.length,
      content_updated: contentUpdated,
      already_archived: alreadyArchived,
      moved,
      chapters: [...chapters.entries()].map(([deckId, chapter]) => ({
        deck_id: deckId,
        chapter_id: chapter.id,
        chapter_name: chapter.name,
        local: chapter.local === true,
      })),
      status: 'pending',
      pending: true,
      message: 'Archive queued locally (chapter + notice + move); call markji_sync to push it, or let idle auto-sync do it.',
    };
  }

  async function editChapter(args = {}) {
    touch();
    await ready();
    const action = args.action;
    const current = cache();
    if (action === 'create') {
      const deckId = typeof args.deck === 'string' ? args.deck : '';
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (deckId === '') throw fail('invalid_argument', 'deck id is required for action=create');
      if (name === '') throw fail('invalid_argument', 'name is required for action=create');
      if (!current.decks[deckId]) {
        await forcePullForMissing('create-chapter');
        if (!current.decks[deckId]) throw fail('unknown_deck', 'Unknown deck: ' + deckId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
      }
      const order = Number.isInteger(args.order) ? Math.max(0, args.order) : undefined;
      const id = makeLocalId('ch');
      const record = {
        id,
        deck_id: deckId,
        name,
        revision: null,
        updated_time: null,
        order: order === undefined ? Object.keys(current.chapters).filter((key) => current.chapters[key].deck_id === deckId).length : order,
        card_ids: [],
        local: true,
        pending: { op: 'create', name, ...(order === undefined ? {} : { order }) },
        pulled_at: 0,
      };
      current.chapters[id] = record;
      const deck = current.decks[deckId];
      deck.chapter_ids = dedupe([...(deck.chapter_ids ?? []), id]);
      await store.flush();
      return {
        ok: true,
        action: 'create',
        chapter_id: id,
        deck_id: deckId,
        status: 'new',
        pending: true,
        message: 'Chapter queued locally; it will be created on the next push.',
      };
    }
    if (action === 'rename') {
      const chapterId = typeof args.chapter === 'string' ? args.chapter : '';
      const name = typeof args.name === 'string' ? args.name.trim() : '';
      if (chapterId === '') throw fail('invalid_argument', 'chapter id is required for action=rename');
      if (name === '') throw fail('invalid_argument', 'name is required for action=rename');
      let chapter = current.chapters[chapterId];
      if (!chapter) {
        await forcePullForMissing('rename-chapter');
        chapter = current.chapters[chapterId];
      }
      if (!chapter) throw fail('unknown_chapter', 'Unknown chapter: ' + chapterId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
      if (chapter.local && chapter.pending && chapter.pending.op === 'create') {
        chapter.name = name;
        chapter.pending.name = name;
      } else {
        chapter.pending = { op: 'rename', name, base_revision: chapter.revision };
        chapter.name = name;
      }
      await store.flush();
      return {
        ok: true,
        action: 'rename',
        chapter_id: chapterId,
        status: chapter.local ? 'new' : 'pending',
        pending: true,
        message: 'Rename queued locally; call markji_sync to push it now, or let idle auto-sync push it.',
      };
    }
    if (action === 'sort') {
      const deckId = typeof args.deck === 'string' ? args.deck : '';
      if (deckId === '') throw fail('invalid_argument', 'deck id is required for action=sort');
      const deck = current.decks[deckId];
      if (!deck) throw fail('unknown_deck', 'Unknown deck: ' + deckId + ' is not in the local cache', 'call markji_sync with mode=pull full=true first');
      const ids = Array.isArray(args.chapter_ids) ? dedupe(args.chapter_ids) : [];
      const own = Object.values(current.chapters).filter((chapter) => chapter.deck_id === deckId).map((chapter) => chapter.id);
      const ownSet = new Set(own);
      if (ids.length !== own.length || ids.some((id) => !ownSet.has(id))) {
        throw fail('invalid_argument', 'chapter_ids must list every chapter of deck ' + deckId + ' exactly once (got ' + ids.length + ', expected ' + own.length + ')');
      }
      deck.pending_sort = { chapter_ids: ids, base_revision: deck.chapterset_revision };
      ids.forEach((id, index) => {
        current.chapters[id].order = index;
      });
      deck.chapter_ids = ids.slice();
      await store.flush();
      return {
        ok: true,
        action: 'sort',
        deck_id: deckId,
        chapters: ids.length,
        status: 'pending',
        pending: true,
        message: 'Chapter order queued locally; call markji_sync to push it now, or let idle auto-sync push it.',
      };
    }
    throw fail('invalid_argument', 'action must be one of create, rename, sort');
  }

  // ------------------------------------------------------------ conflicts ---

  /** At most this many conflicts may be resolved in one batch call. */
  const MAX_RESOLVE_BATCH = 50;

  function validStrategy(value) {
    return value === 'keep_local' || value === 'keep_remote' || value === 'use_content';
  }

  function resolveErrorDetails(error) {
    const source = isObject(error) ? error : null;
    return {
      code: source !== null && typeof source.code === 'string' && source.code !== '' ? source.code : 'unknown',
      message: errMessage(error),
    };
  }

  /**
   * Resolve one conflict, mutating the cache but not flushing it: the caller
   * flushes so a batch lands in one write. Every failure path validates before
   * mutating, so an item that fails leaves the other items untouched.
   */
  async function resolveOne(conflictId, strategy, replacement) {
    const id = typeof conflictId === 'string' ? conflictId : '';
    if (id === '') throw fail('invalid_argument', 'conflict id is required');
    if (!validStrategy(strategy)) {
      throw fail('invalid_argument', 'strategy must be keep_local, keep_remote or use_content');
    }
    const current = cache();
    const conflict = current.conflicts.find((entry) => entry.id === id && entry.state === 'open');
    if (!conflict) throw fail('unknown_conflict', 'Unknown conflict: no open conflict with id ' + id, 'call markji_sync action=state to list open conflicts');
    let content = null;
    if (strategy === 'use_content') {
      content = normalizeContent(replacement, 'markji_sync action=resolve');
    }
    if (conflict.entity === 'card') {
      const card = conflict.card_id ? current.cards[conflict.card_id] : null;
      if (card && conflict.kind === 'card-move-conflict') {
        if (strategy === 'keep_local') {
          const target = conflict.local;
          if (typeof target === 'string' && current.chapters[target]) {
            current.moves.push({
              id: 'move_' + randomUUID().replace(/-/g, '').slice(0, 12),
              deck_id: conflict.deck_id,
              from_chapter_id: conflict.remote,
              card_ids: [card.id],
              to_chapter_id: target,
              order: null,
              created_at: clock(),
            });
            card.chapter_id = target;
          }
        } else if (strategy === 'keep_remote') {
          const target = conflict.remote;
          if (typeof target === 'string' && current.chapters[target]) {
            detachCardId(card.id);
            card.chapter_id = target;
            insertCardId(target, card.id, undefined);
            if (card.cloud) card.cloud.chapter_id = target;
          }
        } else {
          throw fail('invalid_argument', 'use_content is not supported for a card-move-conflict');
        }
        card.conflict = null;
        clearCardError(card);
      } else if (card) {
        if (strategy === 'keep_local') {
          if (conflict.kind === 'card-remote-deleted' || conflict.kind === 'deck-deleted') {
            card.local = true;
            card.cloud = null;
            card.pending = { content: conflict.local ?? card.content, grammar_version: card.grammar_version ?? config.grammarVersion };
            card.content = card.pending.content;
          } else {
            card.pending = { content: conflict.local ?? card.content, grammar_version: (card.cloud ? card.cloud.grammar_version : null) ?? card.grammar_version ?? config.grammarVersion };
            card.content = card.pending.content;
          }
          card.conflict = null;
        } else if (strategy === 'keep_remote') {
          if (conflict.kind === 'card-remote-deleted' || conflict.kind === 'deck-deleted' || !card.cloud) {
            detachCardId(card.id);
            delete current.cards[card.id];
          } else {
            card.content = card.cloud.content;
            card.grammar_version = card.cloud.grammar_version ?? card.grammar_version;
            card.pending = null;
            card.conflict = null;
            card.updated_time = card.cloud.updated_time ?? card.updated_time;
          }
        } else {
          card.pending = { content, grammar_version: (card.cloud ? card.cloud.grammar_version : null) ?? card.grammar_version ?? config.grammarVersion };
          card.content = content;
          card.conflict = null;
        }
        clearCardError(card);
      }
    } else if (conflict.entity === 'chapter') {
      const chapter = conflict.chapter_id ? current.chapters[conflict.chapter_id] : null;
      const deck = conflict.deck_id ? current.decks[conflict.deck_id] : null;
      if (conflict.op === 'delete') {
        if (strategy === 'keep_local') {
          if (chapter && chapter.missing) {
            chapter.missing = false;
            chapter.local = true;
            chapter.pending = { op: 'create', name: typeof conflict.local === 'string' && conflict.local !== '' ? conflict.local : chapter.name, order: chapter.order ?? null };
            chapter.revision = null;
            // The chapter is coming back, so its cards that were reported as remotely
            // deleted must come back with it; otherwise each sibling card conflict would
            // have to be resolved separately before anything could be pushed.
            for (const card of Object.values(current.cards)) {
              if (card.chapter_id !== chapter.id || !card.conflict) continue;
              const sibling = current.conflicts.find((entry) => entry.id === card.conflict && entry.state === 'open');
              if (!sibling || sibling.kind !== 'card-remote-deleted') continue;
              card.local = true;
              card.cloud = null;
              card.pending = { content: sibling.local ?? card.content, grammar_version: card.grammar_version ?? config.grammarVersion };
              card.content = card.pending.content;
              card.conflict = null;
              clearCardError(card);
              sibling.state = 'resolved';
              sibling.resolved_at = clock();
              sibling.resolution = 'keep_local';
            }
          }
        } else if (strategy === 'keep_remote') {
          if (chapter) {
            for (const card of Object.values(current.cards)) {
              if (card.chapter_id !== chapter.id) continue;
              if (card.conflict) {
                const dangling = current.conflicts.find((entry) => entry.id === card.conflict && entry.state === 'open');
                if (dangling) {
                  dangling.state = 'resolved';
                  dangling.resolved_at = clock();
                  dangling.resolution = 'keep_remote';
                }
              }
              detachCardId(card.id);
              delete current.cards[card.id];
            }
            delete current.chapters[chapter.id];
          }
          if (deck && Array.isArray(deck.chapter_ids)) {
            deck.chapter_ids = deck.chapter_ids.filter((id) => id !== conflict.chapter_id);
          }
        } else {
          throw fail('invalid_argument', 'use_content is not supported for a deleted chapter');
        }
      } else if (strategy === 'keep_local') {
        if (conflict.op === 'rename' && chapter && chapter.pending && chapter.pending.op === 'rename') {
          chapter.pending.base_revision = chapter.revision;
        } else if (conflict.op === 'sort' && deck && deck.pending_sort) {
          deck.pending_sort.base_revision = deck.chapterset_revision;
        }
      } else {
        if (conflict.op === 'rename' && chapter && chapter.pending && chapter.pending.op === 'rename') {
          chapter.pending = null;
          if (typeof conflict.remote === 'string' && conflict.remote !== '') chapter.name = conflict.remote;
        } else if (conflict.op === 'sort' && deck) {
          deck.pending_sort = null;
        }
      }
    } else if (conflict.entity === 'deck') {
      const card = conflict.card_id ? current.cards[conflict.card_id] : null;
      if (card) {
        if (strategy === 'keep_local') {
          card.local = true;
          card.cloud = null;
          card.pending = { content: conflict.local ?? card.content, grammar_version: card.grammar_version ?? config.grammarVersion };
          card.content = card.pending.content;
          card.conflict = null;
        } else {
          detachCardId(card.id);
          delete current.cards[card.id];
        }
      }
    }
    conflict.state = 'resolved';
    conflict.resolved_at = clock();
    conflict.resolution = strategy;
    return { ok: true, id, entity: conflict.entity, strategy, state: 'resolved', changed: true };
  }

  /** Apply one parsed batch item and shape its per-item result. */
  async function resolveBatchItem(item) {
    try {
      const result = await resolveOne(item.id, item.strategy, item.content);
      return {
        id: result.id,
        ok: true,
        changed: result.changed,
        state: result.state,
        strategy: result.strategy,
      };
    } catch (error) {
      const details = resolveErrorDetails(error);
      return { id: item.id, ok: false, changed: false, strategy: item.strategy, error: details };
    }
  }

  /**
   * Resolve conflicts: the single-id shortcut is byte-for-byte compatible with
   * the previous contract, and there are two batch forms for the common
   * "dozens of conflicts at once" case:
   *   - ids: string[] + strategy: apply one strategy to up to 50 unique ids
   *     (use_content also needs content);
   *   - items: [{ id, strategy, content? }]: up to 50 unique ids with mixed
   *     strategies.
   * ids and items are mutually exclusive, and neither can be combined with id.
   * Per-item failures (unknown/already resolved id, bad strategy, use_content
   * without content) are reported in results and never abort the rest; fatal
   * argument errors fail the whole call. Duplicate ids are collapsed.
   */
  async function resolveConflict(args = {}) {
    touch();
    await ready();
    const hasIds = args.ids !== undefined && args.ids !== null;
    const hasItems = args.items !== undefined && args.items !== null;
    const hasSingle = typeof args.id === 'string' && args.id !== '';
    if (hasIds && hasItems) throw fail('invalid_argument', 'pass either ids or items, not both');
    if (hasSingle && (hasIds || hasItems)) throw fail('invalid_argument', 'pass either id or ids/items, not both');
    if (!hasSingle && !hasIds && !hasItems) {
      throw fail('invalid_argument', 'conflict id is required (or pass ids/items to resolve several conflicts)');
    }

    if (hasSingle) {
      const result = await resolveOne(args.id, args.strategy, args.content);
      await store.flush();
      return result;
    }

    const items = [];
    if (hasIds) {
      if (!validStrategy(args.strategy)) {
        throw fail('invalid_argument', 'strategy must be keep_local, keep_remote or use_content');
      }
      if (!Array.isArray(args.ids)) throw fail('invalid_argument', 'ids must be an array of conflict ids');
      const ids = dedupe(args.ids);
      if (ids.length === 0) throw fail('invalid_argument', 'ids must contain at least one conflict id');
      if (ids.length > MAX_RESOLVE_BATCH) {
        throw fail('invalid_argument', 'ids supports at most ' + MAX_RESOLVE_BATCH + ' unique conflict ids per call');
      }
      let content;
      if (args.strategy === 'use_content') {
        content = normalizeContent(args.content, 'markji_sync action=resolve');
      } else if (args.content !== undefined && args.content !== null && args.content !== '') {
        throw fail('invalid_argument', 'content is only supported with strategy use_content; pass items for mixed strategies');
      }
      for (const id of ids) items.push({ id, strategy: args.strategy, content });
    } else {
      if (!Array.isArray(args.items)) {
        throw fail('invalid_argument', 'items must be an array of { id, strategy, content? }');
      }
      if (args.items.length === 0) throw fail('invalid_argument', 'items must contain at least one conflict');
      const seen = new Set();
      for (let index = 0; index < args.items.length; index += 1) {
        const item = args.items[index];
        if (!isObject(item)) throw fail('invalid_argument', 'items[' + index + '] must be an object with id and strategy');
        if (typeof item.id !== 'string' || item.id.trim() === '') {
          throw fail('invalid_argument', 'items[' + index + '].id is required');
        }
        const id = item.id.trim();
        if (seen.has(id)) continue;
        seen.add(id);
        items.push({ id, strategy: item.strategy, content: item.content });
      }
      if (items.length > MAX_RESOLVE_BATCH) {
        throw fail('invalid_argument', 'items supports at most ' + MAX_RESOLVE_BATCH + ' unique conflicts per call');
      }
    }

    const results = [];
    for (const item of items) results.push(await resolveBatchItem(item));
    const resolved = results.filter((entry) => entry.ok === true).length;
    const failed = results.length - resolved;
    if (resolved > 0) await store.flush();
    return { ok: failed === 0, total: results.length, resolved, failed, results };
  }

  // ---------------------------------------------------------------- sync ----

  function buildReport(mode, startedAt, pullReport, pushReport) {
    const current = cache();
    const errors = pushReport ? pushReport.errors : [];
    const counts = pendingCounts();
    return {
      ok: errors.length === 0,
      mode,
      started_at: startedAt,
      finished_at: clock(),
      duration_ms: clock() - startedAt,
      pull: pullReport,
      push: pushReport
        ? {
            chapters_created: pushReport.chapters_created,
            chapters_renamed: pushReport.chapters_renamed,
            chapters_sorted: pushReport.chapters_sorted,
            cards_created: pushReport.cards_created,
            cards_updated: pushReport.cards_updated,
            cards_moved: pushReport.cards_moved,
            conflicts: pushReport.conflicts,
            errors: pushReport.errors,
          }
        : null,
      conflicts: conflictViews(),
      errors,
      cache: {
        last_pull_at: current.meta.last_pull_at ?? null,
        last_push_at: current.meta.last_push_at ?? null,
        pending_cards: counts.cards_new + counts.cards_dirty,
        pending_chapters: counts.chapters_new + counts.chapters_rename,
      },
    };
  }
  function compactProgress(progress) {
    const view = {
      message: typeof progress.message === 'string' ? progress.message : '',
      decks_total: progress.decks_total ?? 0,
      decks_done: progress.decks_done ?? 0,
    };
    for (const key of ['chapters', 'cards', 'cards_deleted', 'adopted_cards', 'adopted_chapters', 'conflicts_created', 'chapters_created', 'chapters_renamed', 'chapters_sorted', 'cards_created', 'cards_updated', 'cards_moved', 'errors']) {
      if (typeof progress[key] === 'number' && progress[key] !== 0) view[key] = progress[key];
    }
    return view;
  }
  function compactCounts(source, keys) {
    const view = {};
    for (const key of keys) {
      if (typeof source[key] === 'number' && source[key] !== 0) view[key] = source[key];
    }
    return view;
  }
  function compactReport(report) {
    const view = { ok: report.ok === true, mode: report.mode, duration_ms: report.duration_ms };
    if (report.pull && typeof report.pull === 'object') {
      view.pull = compactCounts(report.pull, ['decks', 'chapters', 'cards', 'cards_deleted', 'adopted_cards', 'adopted_chapters', 'conflicts']);
    }
    if (report.push && typeof report.push === 'object') {
      const push = compactCounts(report.push, ['chapters_created', 'chapters_renamed', 'chapters_sorted', 'cards_created', 'cards_updated', 'cards_moved', 'conflicts']);
      const errors = Array.isArray(report.push.errors) ? report.push.errors : [];
      const errorsTotal = typeof report.push.errors_total === 'number' ? Math.max(report.push.errors_total, errors.length) : errors.length;
      if (errors.length > 0) {
        push.errors = errors.slice(0, 5);
        push.errors_total = errorsTotal;
      }
      view.push = push;
    }
    if (Array.isArray(report.conflicts) && report.conflicts.length > 0) view.conflicts = report.conflicts;
    if (Array.isArray(report.errors) && report.errors.length > 0) {
      view.errors = report.errors.slice(0, 5);
      view.errors_total = typeof report.errors_total === 'number' ? Math.max(report.errors_total, report.errors.length) : report.errors.length;
    }
    return view;
  }
  function taskView(task) {
    const progress = task.progress ?? emptyTaskProgress('queued');
    const view = {
      task_id: task.id,
      status: task.status,
      mode: task.mode,
      stage: task.stage ?? 'starting',
      started_at: task.started_at ?? null,
      finished_at: task.finished_at ?? null,
      progress: compactProgress(progress),
      resume_count: task.resume_count ?? 0,
    };
    if (task.full === true) view.full = true;
    if (task.error !== null && task.error !== undefined) view.error = task.error;
    if (task.report) view.report = compactReport(task.report);
    if (task.status === 'running') {
      view.hint = 'Running in the background; wait with markji_sync action=wait task_id=' + task.id + ' or poll action=progress.';
    } else if (task.status === 'interrupted') {
      view.hint = task.error !== null && typeof task.error === 'object' && task.error.code === 'cancelled'
        ? 'This task was cancelled at your request. Queued edits were kept; call markji_sync with resume="' + task.id + '" to continue.'
        : 'The host stopped before this task finished. Call markji_sync with resume="' + task.id + '" to run it again; the pull-before-push pipeline is idempotent.';
    } else if (task.status === 'failed') {
      view.hint = 'This task failed. Call markji_sync with resume="' + task.id + '" to retry it.';
    }
    return view;
  }
  /**
   * Watch one task until it reaches a terminal state.
   *
   * The callback runs once with a task view. A task that already finished is
   * reported on a microtask, so a tool can register after startSync() returns
   * without losing a fast completion. Returns false when the task is unknown.
   */
  function watchTask(taskId, callback) {
    if (typeof taskId !== 'string' || taskId === '' || typeof callback !== 'function') return false;
    const task = cache().tasks[taskId];
    if (task === undefined) return false;
    if (task.status !== 'running') {
      queueMicrotask(() => {
        try {
          callback(taskView(task));
        } catch (error) {
          log('warn', 'sync task watcher failed: ' + errMessage(error));
        }
      });
      return true;
    }
    let watchers = taskWatchers.get(taskId);
    if (watchers === undefined) {
      watchers = new Set();
      taskWatchers.set(taskId, watchers);
    }
    watchers.add(callback);
    return true;
  }
  /**
   * Watch a task's live progress. The callback receives an immediate snapshot
   * and then every applied progress event until the task settles. Returns
   * false when the task is unknown.
   */
  function watchTaskProgress(taskId, callback) {
    if (typeof taskId !== 'string' || taskId === '' || typeof callback !== 'function') return false;
    const task = cache().tasks[taskId];
    if (task === undefined) return false;
    let watchers = taskProgressWatchers.get(taskId);
    if (watchers === undefined) {
      watchers = new Set();
      taskProgressWatchers.set(taskId, watchers);
    }
    watchers.add(callback);
    queueMicrotask(() => {
      try {
        callback(taskView(task));
      } catch (error) {
        log('warn', 'sync task progress watcher failed: ' + errMessage(error));
      }
    });
    return true;
  }
  /** Publish the task's current progress view to its progress watchers. */
  function deliverTaskProgress(task) {
    const watchers = taskProgressWatchers.get(task.id);
    if (watchers === undefined) return;
    const view = taskView(task);
    for (const watcher of watchers) {
      try {
        watcher(view);
      } catch (error) {
        log('warn', 'sync task progress watcher failed: ' + errMessage(error));
      }
    }
  }
  /**
   * Ask one running task to stop at its next safe checkpoint.
   *
   * The pipeline checks this abort signal between provider calls; an in-flight
   * HTTP request is allowed to finish, then the task is persisted as
   * interrupted and can be resumed with resume=<task_id>. Returns false when
   * this process does not own a live run for the task.
   */
  function cancelTask(taskId, reason) {
    const controller = taskAborts.get(taskId);
    if (controller === undefined) return false;
    controller.abort(typeof reason === 'string' && reason !== '' ? reason : 'cancelled by user');
    const task = cache().tasks[taskId];
    if (task !== undefined && task.status === 'running') {
      task.stage = 'stopping';
      task.progress = task.progress ?? emptyTaskProgress('');
      task.progress.message = 'cancellation requested';
      task.updated_at = clock();
      store.markDirty();
      deliverTaskProgress(task);
    }
    return true;
  }
  /** Whether this engine owns the live run for a task (false for a foreign process's task). */
  function ownsTask(taskId) {
    return taskAborts.has(taskId) || taskPromises.has(taskId);
  }
  /** Deliver one terminal task to every registered watcher exactly once. */
  function deliverTaskWatchers(task) {
    taskProgressWatchers.delete(task.id);
    const watchers = taskWatchers.get(task.id);
    if (watchers === undefined) return;
    taskWatchers.delete(task.id);
    const view = taskView(task);
    for (const watcher of watchers) {
      try {
        watcher(view);
      } catch (error) {
        log('warn', 'sync task watcher failed: ' + errMessage(error));
      }
    }
  }
  function taskViews(limit = 10) {
    return Object.values(cache().tasks)
      .sort((a, b) => (b.started_at ?? 0) - (a.started_at ?? 0))
      .slice(0, Math.max(1, limit))
      .map((task) => taskView(task));
  }
  function pruneTasks() {
    const current = cache();
    const ids = Object.keys(current.tasks);
    if (ids.length <= TASK_HISTORY_LIMIT) return;
    const finished = ids
      .map((id) => current.tasks[id])
      .filter((task) => task.status !== 'running')
      .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
    let excess = ids.length - TASK_HISTORY_LIMIT;
    for (const task of finished) {
      if (excess <= 0) break;
      delete current.tasks[task.id];
      excess -= 1;
    }
  }
  function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but we may not signal it.
      return Boolean(error && error.code === 'EPERM');
    }
  }
  /**
   * A running task is only stale when its owning process is provably gone.
   * Without this check a second DSH process would mark the first process's
   * live sync task interrupted just by starting the plugin.
   */
  function taskOwnerAlive(task) {
    const owner = isObject(task.owner) ? task.owner : null;
    if (owner === null || !Number.isInteger(owner.pid)) return false; // legacy/unknown owner
    const seen = task.updated_at ?? task.started_at ?? 0;
    const age = clock() - seen;
    if (owner.host === HOSTNAME) return pidAlive(owner.pid) && age < TASK_OWNER_STALE_MS;
    return age < TASK_FOREIGN_STALE_MS;
  }
  async function recoverTasks() {
    const stale = Object.values(cache().tasks).filter((task) => task.status === 'running' && !taskOwnerAlive(task));
    if (stale.length === 0) return;
    try {
      await store.withWriteLock(
        async () => {
          await store.refreshIfChanged();
          let changed = false;
          for (const task of Object.values(cache().tasks)) {
            if (task.status !== 'running' || taskOwnerAlive(task)) continue;
            task.status = 'interrupted';
            task.interrupted_at = clock();
            task.updated_at = clock();
            task.error = { code: 'interrupted', message: 'host stopped before the task finished' };
            changed = true;
            log('warn', 'sync task ' + task.id + ' was interrupted by a host restart; resume it with markji_sync resume=' + task.id);
          }
          if (changed) await store.saveNow();
        },
        { timeoutMs: 15000 },
      );
    } catch (error) {
      log('warn', 'could not recover interrupted task state: ' + errMessage(error));
    }
  }
  function applyTaskEvent(task, event) {
    if (!isObject(event)) return;
    const progress = task.progress ?? emptyTaskProgress('');
    task.progress = progress;
    if (event.stage === 'pull') {
      task.stage = 'pull';
      if (event.phase === 'plan') {
        progress.decks_total = event.decks_total;
        progress.decks_seen = event.decks_seen;
        progress.message = 'pull: ' + event.decks_total + ' deck(s) to fetch';
      } else if (event.phase === 'deck') {
        progress.decks_done = event.decks_done;
        progress.chapters = event.chapters;
        progress.cards = event.cards;
        progress.cards_deleted = event.cards_deleted;
        progress.adopted_cards = event.adopted_cards;
        progress.adopted_chapters = event.adopted_chapters;
        progress.conflicts_created = event.conflicts;
        progress.message = 'pull: deck ' + event.decks_done + '/' + event.decks_total + (event.deck_name ? ' ' + event.deck_name : '');
      } else if (event.phase === 'done') {
        progress.decks_done = event.pull.decks;
        progress.message = 'pull done: ' + event.pull.decks + ' deck(s), ' + event.pull.cards + ' card(s)';
      }
    } else if (event.stage === 'push') {
      task.stage = 'push';
      if (event.phase === 'stage') {
        progress.message = 'push: ' + event.stage_name;
      } else if (event.phase === 'item' || event.phase === 'done') {
        if (isObject(event.counters)) {
          for (const key of Object.keys(event.counters)) progress[key] = event.counters[key];
        }
      }
      if (event.phase === 'done') {
        if (event.push && Array.isArray(event.push.errors)) progress.errors = event.push.errors.length;
        progress.message = 'push done';
      }
    }
    task.updated_at = clock();
    store.markDirty();
    deliverTaskProgress(task);
  }
  async function runTask(task, signal) {
    try {
      task.status = 'running';
      task.stage = 'starting';
      task.updated_at = clock();
      const onEvent = (event) => applyTaskEvent(task, event);
      const report = await runPipeline({
        mode: task.mode,
        full: task.full === true,
        signal,
        onEvent,
        adoptLocal: (task.resume_count ?? 0) > 0,
      });
      task.status = 'completed';
      task.stage = 'done';
      task.finished_at = clock();
      task.updated_at = task.finished_at;
      task.report = compactReport(report);
      task.progress.message = 'completed';
      task.progress.conflicts_created = report.conflicts.length;
      await store.saveNow();
      log(
        'info',
        'sync task ' + task.id + ' completed in ' + String(task.finished_at - task.started_at) + 'ms (pull decks ' +
          String(report.pull ? report.pull.decks : 0) + ', pushed cards ' +
          String(report.push ? report.push.cards_created + report.push.cards_updated : 0) + ')',
      );
      return taskView(task);
    } catch (error) {
      const cancelled = signal !== undefined && signal.aborted;
      task.status = cancelled ? 'interrupted' : 'failed';
      task.stage = cancelled ? 'stopping' : 'done';
      task.finished_at = clock();
      task.updated_at = task.finished_at;
      task.error = cancelled
        ? { code: 'cancelled', message: 'sync task cancelled by the user; resume it with markji_sync' }
        : {
            code: isObject(error) && typeof error.code === 'string' ? error.code : 'sync_failed',
            message: errMessage(error),
          };
      try {
        await store.saveNow();
      } catch {
        /* keep the original task error */
      }
      log(cancelled ? 'warn' : 'error', cancelled ? 'sync task ' + task.id + ' cancelled' : 'sync task ' + task.id + ' failed: ' + errMessage(error));
      return taskView(task);
    } finally {
      if (activeTaskId === task.id) activeTaskId = null;
      taskPromises.delete(task.id);
      taskAborts.delete(task.id);
      deliverTaskWatchers(task);
    }
  }
  async function runTaskById(taskId, signal) {
    return store.withWriteLock(
      async () => {
        await store.refreshIfChanged();
        const task = cache().tasks[taskId];
        if (!task) throw fail('unknown_task', 'Sync task ' + taskId + ' disappeared from the cache');
        return runTask(task, signal);
      },
      {
        timeoutMs: 1800000,
        onWait: () => {
          const waiting = cache().tasks[taskId];
          if (!waiting || waiting.status !== 'running') return;
          waiting.stage = 'waiting_lock';
          waiting.progress.message = 'waiting for another DSH process to finish writing the cache';
          waiting.updated_at = clock();
          store.markDirty();
        },
      },
    );
  }
  async function startSync(args = {}) {
    touch();
    await ready();
    await refreshIfIdle();
    const current = cache();
    if (activeTaskId !== null) {
      const running = current.tasks[activeTaskId];
      if (running && running.status === 'running') return { task: taskView(running), already_running: true };
      activeTaskId = null;
    }
    // Another DSH process may be running a task. Do not start a duplicate:
    // report that task instead; its owner keeps the writer lock until it ends.
    const foreignRunning = Object.values(current.tasks).find((task) => task && task.status === 'running');
    if (foreignRunning) return { task: taskView(foreignRunning), already_running: true };
    const mode = args.mode === undefined ? 'auto' : args.mode;
    if (mode !== 'auto' && mode !== 'pull' && mode !== 'push') {
      throw fail('invalid_argument', 'mode must be auto, pull or push');
    }
    const full = args.full === true;
    const resumeId = typeof args.resume === 'string' && args.resume !== '' ? args.resume : null;
    let task;
    if (resumeId !== null) {
      task = current.tasks[resumeId];
      if (!task) throw fail('unknown_task', 'No sync task with id ' + resumeId, 'call markji_sync action=progress to list persisted tasks');
      if (task.status === 'running') return { task: taskView(task), already_running: true };
      if (task.status !== 'interrupted' && task.status !== 'failed') {
        throw fail('task_not_resumable', 'Task ' + resumeId + ' is ' + task.status + '; only an interrupted or failed task can be resumed');
      }
      if (args.mode !== undefined) task.mode = mode;
      if (args.full !== undefined) task.full = full;
      task.status = 'running';
      task.stage = 'starting';
      task.updated_at = clock();
      task.finished_at = null;
      task.owner = { pid: process.pid, host: HOSTNAME };
      task.resume_count = (task.resume_count ?? 0) + 1;
      task.error = null;
      task.progress = emptyTaskProgress('resumed; waiting for the pull phase');
      activeTaskId = task.id;
    } else {
      const id = 'sync_' + randomUUID().replace(/-/g, '').slice(0, 12);
      task = {
        id,
        mode,
        full,
        status: 'running',
        started_at: clock(),
        updated_at: clock(),
        finished_at: null,
        stage: 'starting',
        progress: emptyTaskProgress('queued'),
        owner: { pid: process.pid, host: HOSTNAME },
        resume_count: 0,
        error: null,
        report: null,
      };
      current.tasks[id] = task;
      activeTaskId = id;
      pruneTasks();
    }
    const view = taskView(task);
    await store.saveNow();
    const controller = new AbortController();
    taskAborts.set(task.id, controller);
    const promise = withLock(() => runTaskById(task.id, controller.signal))
      .catch(() => taskView(task))
      .finally(() => taskAborts.delete(task.id));
    taskPromises.set(task.id, promise);
    void promise;
    return { task: view };
  }
  async function syncTaskStatus(args = {}) {
    await ready();
    const current = cache();
    const id = typeof args.task_id === 'string' && args.task_id !== '' ? args.task_id : null;
    const active = activeTaskId !== null && current.tasks[activeTaskId] ? taskView(current.tasks[activeTaskId]) : null;
    if (id !== null) {
      const task = current.tasks[id];
      if (!task) throw fail('unknown_task', 'No sync task with id ' + id, 'call markji_sync action=progress without task_id to list tasks');
      return { task: taskView(task) };
    }
    return { active, tasks: taskViews(3) };
  }
  async function waitForTask(taskId, timeoutMs = 1800000) {
    await ready();
    const deadline = Date.now() + Math.max(0, timeoutMs);
    const promise = taskPromises.get(taskId);
    if (promise) {
      let timer = null;
      const timeout = new Promise((resolve) => {
        timer = setTimeout(resolve, Math.max(0, deadline - Date.now()), null);
        if (typeof timer.unref === 'function') timer.unref();
      });
      try {
        await Promise.race([promise, timeout]);
      } finally {
        if (timer !== null) clearTimeout(timer);
      }
    } else {
      // Another DSH process may own the task. Its progress is committed to the
      // shared cache, so poll the snapshot instead of returning immediately.
      let task = cache().tasks[taskId];
      while (task !== undefined && task.status === 'running' && Date.now() < deadline) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.min(250, Math.max(0, deadline - Date.now())));
          if (typeof timer.unref === 'function') timer.unref();
        });
        if (typeof store.refreshIfChanged === 'function') {
          try {
            await store.refreshIfChanged();
          } catch {
            /* a busy/corrupt cache is reported by the next status read */
          }
        }
        task = cache().tasks[taskId];
      }
    }
    const task = cache().tasks[taskId];
    if (!task) return null;
    const view = taskView(task);
    if (view.status === 'running' && Date.now() >= deadline) view.timed_out = true;
    return view;
  }
  async function runPipeline(options = {}) {
    await ready();
    const mode = options.mode === undefined ? 'auto' : options.mode;
    const full = options.full === true;
    const signal = options.signal;
    const check = () => {
      if (signal !== undefined && signal.aborted) throw new Error('sync task cancelled');
    };
    const startedAt = clock();
    syncing = true;
    try {
      check();
      let pullReport = null;
      let pushReport = null;
      pullReport = await pullInternal({
        full,
        reason: mode,
        signal,
        onEvent: options.onEvent,
        adoptLocal: options.adoptLocal === true,
      });
      check();
      if (mode !== 'pull') pushReport = await pushInternal({ reason: mode, signal, onEvent: options.onEvent });
      const report = buildReport(mode, startedAt, pullReport, pushReport);
      cache().meta.last_sync = {
        mode,
        ok: report.ok,
        started_at: report.started_at,
        finished_at: report.finished_at,
        duration_ms: report.duration_ms,
        conflicts: report.conflicts.length,
        errors: report.errors.length,
      };
      await store.saveNow();
      return report;
    } catch (error) {
      cache().meta.last_error = errMessage(error);
      try {
        await store.saveNow();
      } catch {
        /* keep the original error */
      }
      throw error;
    } finally {
      syncing = false;
    }
  }
  async function sync(args = {}) {
    touch();
    await ready();
    const mode = args.mode === undefined ? 'auto' : args.mode;
    if (mode !== 'auto' && mode !== 'pull' && mode !== 'push') {
      throw fail('invalid_argument', 'mode must be auto, pull or push');
    }
    const full = args.full === true;
    return withLock(() =>
      store.withWriteLock(
        async () => {
          await store.refreshIfChanged();
          return runPipeline({ mode, full });
        },
        { timeoutMs: 1800000 },
      ),
    );
  }
  async function pull(args = {}) {
    touch();
    await ready();
    const full = args.full === true;
    return withLock(() =>
      store.withWriteLock(
        async () => {
          syncing = true;
          try {
            await store.refreshIfChanged();
            return await pullInternal({ full, reason: args.reason ?? 'manual' });
          } finally {
            syncing = false;
          }
        },
        { timeoutMs: 600000 },
      ),
    );
  }
  async function push(args = {}) {
    touch();
    await ready();
    return withLock(() =>
      store.withWriteLock(
        async () => {
          syncing = true;
          try {
            await store.refreshIfChanged();
            await pullInternal({ full: false, reason: args.reason ?? 'push' });
            return await pushInternal({ reason: args.reason ?? 'push' });
          } finally {
            syncing = false;
          }
        },
        { timeoutMs: 600000 },
      ),
    );
  }

  function conflictRecovery(conflict) {
    const strategies = conflict.entity === 'card' ? ['keep_local', 'keep_remote', 'use_content'] : ['keep_local', 'keep_remote'];
    return {
      tool: 'markji_sync',
      action: 'resolve',
      arguments: { action: 'resolve', id: conflict.id, strategy: strategies[0] },
      batch_arguments: { action: 'resolve', ids: [conflict.id], strategy: strategies[0] },
      strategies,
      hint:
        (conflict.entity === 'card'
          ? 'keep_local keeps this device content for the next push; keep_remote adopts the cloud content; use_content queues replacement content. '
          : 'keep_local keeps the local change for the next push; keep_remote adopts the cloud state. ') +
        'Several conflicts can be resolved in one call: pass ids (up to 50 unique ids, one shared strategy) or items [{ id, strategy, content? }] for mixed strategies; arguments still resolves this one conflict.',
    };
  }
  function cardMissingEntity(card) {
    const deck = cache().decks[card.deck_id];
    if (deck && deck.missing) return { code: 'deck_missing', message: 'the card deck is missing from the cloud' };
    const chapter = cache().chapters[card.chapter_id];
    if (chapter && chapter.missing) return { code: 'chapter_missing', message: 'the card chapter is missing from the cloud' };
    if (!chapter) return { code: 'chapter_missing', message: 'the card chapter is not in the local cache' };
    return null;
  }
  function cardRecovery(card, code) {
    if (code === 'not_configured') {
      return {
        tool: 'markji_sync',
        action: 'state',
        arguments: { action: 'state' },
        hint:
          'Open Plugins -> dsh-markji-bridge and save the API Key on the plugin page, then retry. ' +
          'The config apiKey and the MAIMEMO_MARKJI_OPENAPI_TOKEN environment variable are only legacy migration fallbacks.',
      };
    }
    if (code === 'deck_missing') {
      return {
        tool: 'markji_sync',
        action: 'failures',
        arguments: { action: 'failures', card: card.id },
        hint: 'The deck no longer exists in the cloud. Resolve the deck conflict with keep_remote to drop local work, or keep_local to re-create it on the next push.',
      };
    }
    if (code === 'chapter_missing') {
      return {
        tool: 'markji_sync',
        action: 'start',
        arguments: { action: 'start', mode: 'push' },
        hint: 'Push again after the chapter is created; a local archive/target chapter is created before cards are pushed.',
      };
    }
    return {
      tool: 'markji_sync',
      action: 'start',
      arguments: { action: 'start', mode: 'push' },
      hint: 'Retry the push; if the error repeats, inspect the card with markji_cards action=get and the task report with markji_sync action=progress.',
    };
  }
  function failureReport(args = {}) {
    const current = cache();
    const limit = Math.min(200, Math.max(1, Number.isFinite(Number(args.limit)) ? Math.trunc(Number(args.limit)) : 50));
    const cardFilter = typeof args.card === 'string' && args.card !== '' ? args.card : null;
    const deckFilter = typeof args.deck === 'string' && args.deck !== '' ? args.deck : null;
    const conflicts = openConflicts()
      .filter((conflict) => (cardFilter === null || conflict.card_id === cardFilter) && (deckFilter === null || conflict.deck_id === deckFilter))
      .map((conflict) => {
        const card = conflict.card_id ? current.cards[conflict.card_id] : null;
        const deck = conflict.deck_id ? current.decks[conflict.deck_id] : null;
        const chapter = conflict.chapter_id ? current.chapters[conflict.chapter_id] : null;
        return {
          ...conflictView(conflict.id),
          deck_name: deck ? deck.name : null,
          chapter_name: chapter ? chapter.name : null,
          card_snippet: card ? snippet(plainText(card.content)) : null,
          recovery: conflictRecovery(conflict),
        };
      });
    const failed = [];
    const movedCards = new Set();
    for (const move of current.moves) {
      if (!Array.isArray(move.card_ids)) continue;
      for (const id of move.card_ids) movedCards.add(id);
    }
    for (const card of Object.values(current.cards)) {
      if (cardFilter !== null && card.id !== cardFilter) continue;
      if (deckFilter !== null && card.deck_id !== deckFilter) continue;
      if (card.conflict) continue;
      const missing = cardMissingEntity(card);
      const lastError = card.last_error ?? null;
      if (!lastError && !missing) continue;
      // A lingering error on a card with no queued work is no longer actionable.
      // A queued move is queued work too, even though it does not set card.pending.
      if (lastError && !missing && !card.pending && !card.local && !movedCards.has(card.id)) continue;
      failed.push({
        id: card.id,
        deck_id: card.deck_id,
        deck_name: current.decks[card.deck_id] ? current.decks[card.deck_id].name : null,
        chapter_id: card.chapter_id ?? null,
        chapter_name: current.chapters[card.chapter_id] ? current.chapters[card.chapter_id].name : null,
        status: cardStatus(card),
        snippet: snippet(plainText(card.content)),
        error: lastError ?? missing,
        recovery: cardRecovery(card, (lastError && lastError.code) || missing.code),
      });
    }
    const tasks = taskViews(5);
    // taskViews is newest-first: only the latest task's errors are current. An
    // older failed task must not keep reporting after a successful retry.
    const latestTask = tasks.length > 0 ? tasks[0] : null;
    const lastTask =
      latestTask && latestTask.report && Array.isArray(latestTask.report.errors) && latestTask.report.errors.length > 0
        ? latestTask
        : null;
    const lastTaskErrors = lastTask
      ? lastTask.report.errors.map((entry) => ({
          task_id: lastTask.task_id,
          op: entry.op ?? null,
          id: entry.id ?? null,
          code: entry.code ?? 'unknown',
          message: entry.message ?? '',
        }))
      : [];
    const view = {
      ok: true,
      summary: {
        conflicts: conflicts.length,
        failed_cards: failed.length,
        last_task_errors: lastTaskErrors.length,
        last_error: current.meta.last_error ?? null,
      },
      conflicts: conflicts.slice(0, limit),
      failed_cards: failed.slice(0, limit),
      last_task_errors: lastTaskErrors.slice(0, limit),
      // One call can clear the filtered conflicts (up to the 50-id batch limit):
      // keep_remote is the safe default because the archive/move conflicts that
      // usually accumulate in bulk want the cloud state.
      batch_arguments:
        conflicts.length === 0
          ? null
          : {
              action: 'resolve',
              ids: conflicts.slice(0, MAX_RESOLVE_BATCH).map((conflict) => conflict.id),
              strategy: 'keep_remote',
            },
    };
    if (conflicts.length > limit || failed.length > limit || lastTaskErrors.length > limit) view.truncated = true;
    return view;
  }

  function status() {
    const current = cache();
    const counts = pendingCounts();
    const info = cacheInfo();
    const stats = store.stats();
    const view = {
      version: TOOL_VERSION,
      configured: client.configured !== false,
      cache_file: stats.path,
      cache: {
        decks: stats.decks,
        chapters: stats.chapters,
        cards: stats.cards,
        bytes: stats.bytes,
        pulled_at: current.meta.last_pull_at ?? null,
      },
      pending: compactCounts(counts, Object.keys(counts)),
      conflicts: conflictViews(),
      last_sync: current.meta.last_sync ?? null,
      last_error: current.meta.last_error ?? null,
      active_task:
        activeTaskId ??
        (Object.values(current.tasks).find((task) => task && task.status === 'running')?.id ?? null),
      tasks: taskViews(3),
      auto_sync: { enabled: config.autoSync, running: syncing },
    };
    if (info.stale) view.cache.stale = true;
    if (info.error) view.cache.error = info.error;
    if (stats.saveError) view.cache.save_error = stats.saveError;
    return view;
  }

  // ----------------------------------------------------------- auto sync ----

  async function autoTick() {
    if (disposed || syncing) return;
    if (clock() - lastActivityAt < config.idleQuietMs) return;
    const openConflicts = cache().conflicts.filter((entry) => entry && entry.state === 'open').length;
    if (openConflicts > 0) {
      log('debug', 'auto sync skipped: ' + openConflicts + ' open conflict(s) must be resolved first');
    } else if (hasPending()) {
      if (clock() - lastAutoFailureAt < config.retryBackoffMs) return;
      try {
        const started = await startSync({ mode: 'auto' });
        const promise = taskPromises.get(started.task.task_id);
        const view = promise ? await promise : started.task;
        if (view.status === 'failed') {
          lastAutoFailureAt = clock();
          log('error', 'auto sync task failed: ' + (view.error ? view.error.message : 'unknown error'));
        } else if (view.report && view.report.conflicts.length > 0) {
          log('warn', 'auto sync left ' + view.report.conflicts.length + ' open conflict(s): ' + view.report.conflicts.map((entry) => entry.id).join(', '));
        } else {
          log('info', 'auto sync completed (pushed ' + (view.report && view.report.push ? view.report.push.cards_updated + view.report.push.cards_created : 0) + ' card(s))');
        }
      } catch (error) {
        lastAutoFailureAt = clock();
        cache().meta.last_error = errMessage(error);
        log('error', 'auto sync failed: ' + errMessage(error));
        try {
          await store.saveNow();
        } catch {
          /* ignore */
        }
      }
      return;
    }
    if (clock() - lastAutoFailureAt < config.retryBackoffMs) return;
    const last = cache().meta.last_pull_at;
    if (last !== null && last !== undefined && clock() - last < config.autoPullMs) return;
    try {
      await pull({ full: false, reason: 'auto' });
      log('info', 'auto pull completed');
    } catch (error) {
      lastAutoFailureAt = clock();
      log('warn', 'auto pull failed: ' + errMessage(error));
    }
  }
  function startTimer() {
    if (timer !== null || !config.autoSync) return;
    timer = setInterval(() => {
      autoTick().catch((error) => log('warn', 'auto tick error: ' + errMessage(error)));
    }, Math.max(1000, config.idleCheckMs));
    if (typeof timer.unref === 'function') timer.unref();
  }
  async function start() {
    await ready();
    await recoverTasks();
    started = true;
    if (config.autoSync) startTimer();
    return engine;
  }
  async function stop() {
    disposed = true;
    taskWatchers.clear();
    taskProgressWatchers.clear();
    if (activeTaskId !== null) {
      const controller = taskAborts.get(activeTaskId);
      if (controller !== undefined) controller.abort('plugin stopped');
    }
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    const task = activeTaskId !== null ? cache().tasks[activeTaskId] : null;
    if (task && task.status === 'running') {
      task.status = 'interrupted';
      task.interrupted_at = clock();
      task.updated_at = clock();
      task.error = { code: 'interrupted', message: 'plugin stopped before the task finished' };
    }
    try {
      await store.saveNow();
    } catch (error) {
      log('warn', 'cache flush on stop failed: ' + errMessage(error));
    }
  }

  const engine = {
    config,
    ready,
    start,
    stop,
    status,
    touch,
    hasPending,
    ensureFresh,
    listDecks,
    getDeck,
    listChapters,
    getChapter,
    listCards,
    getCard,
    getCards,
    createCard: addCard,
    updateCard: editCard,
    moveCards,
    archiveCards,
    editChapter,
    resolveConflict,
    failures: failureReport,
    sync,
    startSync,
    cancelTask,
    ownsTask,
    syncTaskStatus,
    waitForTask,
    watchTask,
    watchTaskProgress,
    pull,
    push,
    /** Exposed for tests and diagnostics. */
    _internal: { pullInternal, pushInternal, orderedCards },
  };
  // Multi-process consistency: every cache write runs under the cross-process
  // writer lock and reloads a foreign snapshot first; reads reload an idle cache.
  for (const name of ['createCard', 'updateCard', 'moveCards', 'archiveCards', 'editChapter', 'resolveConflict']) {
    const original = engine[name];
    engine[name] = async (...args) =>
      store.withWriteLock(
        async () => {
          await ready();
          await store.refreshIfChanged();
          return original(...args);
        },
        { timeoutMs: 20000 },
      );
  }
  for (const name of ['listDecks', 'getDeck', 'listChapters', 'getChapter', 'listCards', 'getCard', 'getCards', 'syncTaskStatus', 'failures']) {
    const original = engine[name];
    engine[name] = async (...args) => {
      await ready();
      await refreshIfIdle();
      return original(...args);
    };
  }
  return engine;
}
