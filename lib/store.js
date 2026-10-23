// dsh-markji-bridge: local card-cache persistence.
// One SQLite database (cache.db) holds the index and the card content; no files per card.
// Node builtins only (node:sqlite, node:fs, node:crypto).
import { promises as fsp } from 'node:fs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { PLAIN_TEXT_VERSION, plainText } from './plain-text.js';

export const CACHE_VERSION = 4;
export const CACHE_FILENAME = 'cache.db';
export const LEGACY_FILENAME = 'cache.json';
export const LEGACY_CONTENT_DIRNAME = 'content';

/** The documented empty cache (DESIGN.md "Cache schema"). */
export function emptyCache() {
  return {
    version: CACHE_VERSION,
    created_at: 0,
    meta: {
      last_pull_at: null,
      last_full_pull_at: null,
      last_push_at: null,
      last_sync: null,
      last_error: null,
      conflict_seq: 0,
    },
    folders: {},
    decks: {},
    chapters: {},
    cards: {},
    conflicts: [],
    moves: [],
    tasks: {},
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Fill in keys an older/partial cache snapshot might miss. */
export function normalizeCache(parsed) {
  const base = emptyCache();
  const cache = isObject(parsed) ? parsed : base;
  cache.version = CACHE_VERSION;
  cache.created_at = Number.isFinite(cache.created_at) ? cache.created_at : 0;
  cache.meta = isObject(cache.meta) ? cache.meta : {};
  cache.meta.last_pull_at = cache.meta.last_pull_at ?? null;
  cache.meta.last_full_pull_at = cache.meta.last_full_pull_at ?? null;
  cache.meta.last_push_at = cache.meta.last_push_at ?? null;
  cache.meta.last_sync = cache.meta.last_sync ?? null;
  cache.meta.last_error = cache.meta.last_error ?? null;
  cache.meta.conflict_seq = Number.isFinite(cache.meta.conflict_seq) ? cache.meta.conflict_seq : 0;
  cache.folders = isObject(cache.folders) ? cache.folders : {};
  cache.decks = isObject(cache.decks) ? cache.decks : {};
  cache.chapters = isObject(cache.chapters) ? cache.chapters : {};
  cache.cards = isObject(cache.cards) ? cache.cards : {};
  cache.conflicts = Array.isArray(cache.conflicts) ? cache.conflicts : [];
  cache.moves = Array.isArray(cache.moves) ? cache.moves : [];
  cache.tasks = isObject(cache.tasks) ? cache.tasks : {};
  return cache;
}

const SCHEMA_SQL = [
  'CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS folders (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS decks (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS chapters (id TEXT PRIMARY KEY, deck_id TEXT, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, deck_id TEXT, chapter_id TEXT, data TEXT NOT NULL, content TEXT NOT NULL, base_content TEXT, pending_content TEXT, content_hash TEXT NOT NULL, content_bytes INTEGER NOT NULL, text TEXT NOT NULL DEFAULT \'\')',
  'CREATE TABLE IF NOT EXISTS moves (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS conflicts (id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, data TEXT NOT NULL)',
  'CREATE INDEX IF NOT EXISTS idx_chapters_deck ON chapters(deck_id)',
  'CREATE INDEX IF NOT EXISTS idx_cards_deck ON cards(deck_id)',
  'CREATE INDEX IF NOT EXISTS idx_cards_chapter ON cards(chapter_id)',
];

function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function stripCard(card) {
  const out = { ...card };
  delete out.content;
  delete out.text;
  if (isObject(out.pending)) {
    out.pending = { ...out.pending };
    delete out.pending.content;
  }
  if (isObject(out.cloud)) {
    out.cloud = { ...out.cloud };
    delete out.cloud.content;
  }
  return out;
}

function cardContent(card) {
  const content = typeof card.content === 'string' ? card.content : '';
  const base = isObject(card.cloud) && typeof card.cloud.content === 'string' && card.cloud.content !== content ? card.cloud.content : null;
  const pending = isObject(card.pending) && typeof card.pending.content === 'string' ? card.pending.content : null;
  return { content, base, pending };
}

function contentSignature(card) {
  const value = cardContent(card);
  return value.content + '\u0000' + (value.base === null ? '\u0001' : value.base) + '\u0000' + (value.pending === null ? '\u0001' : value.pending);
}

function nowIso() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Windows can keep a just-closed SQLite file locked for a few milliseconds;
 * retry rename/unlink briefly before giving up.
 */
async function renameWithRetry(fs, from, to) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (error) {
      const retriable = error && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES');
      if (!retriable || attempt === 5) throw error;
      await sleep(50);
    }
  }
}
async function unlinkWithRetry(fs, target) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.unlink(target);
      return;
    } catch (error) {
      if (error && error.code === 'ENOENT') return;
      const retriable = error && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES');
      if (!retriable || attempt === 5) throw error;
      await sleep(50);
    }
  }
}

/**
 * Create the cache store.
 *
 * @param options.dataDir   directory that holds cache.db (required)
 * @param options.log       (level, message) sink, optional
 * @param options.clock     () => ms, injectable for deterministic tests
 * @param options.saveDebounceMs  debounce for markDirty(), default 400
 */
export function createStore(options = {}) {
  const dataDir = options.dataDir === undefined || options.dataDir === null ? '' : String(options.dataDir);
  if (dataDir === '') throw new Error('createStore: dataDir is required');
  const log = typeof options.log === 'function' ? options.log : () => {};
  const clock = typeof options.clock === 'function' ? options.clock : Date.now;
  const fs = options.fsImpl ?? fsp;
  const debounceMs = Number.isFinite(options.saveDebounceMs) ? Math.max(0, options.saveDebounceMs) : 400;
  const dbPath = join(dataDir, CACHE_FILENAME);
  const legacyPath = join(dataDir, LEGACY_FILENAME);
  const legacyContentDir = join(dataDir, LEGACY_CONTENT_DIRNAME);

  let cache = emptyCache();
  let loaded = false;
  let loadPromise = null;
  let loadedAt = null;
  let savedAt = null;
  let db = null;
  let dbBytes = 0;
  let contentBytes = 0;
  let contentFiles = 0;
  let saveError = null;
  let saveTimer = null;
  let saveSeq = 0;
  let saveChain = Promise.resolve();
  let dirty = false;
  let lastFileSize = -1;
  let lastFileMtimeMs = -1;
  /** SQLite data_version is the authoritative "another connection committed" signal. */
  let lastDataVersion = null;
  /** Cross-process writer lock (one writer/sync at a time; readers never take it). */
  const lockPath = join(dataDir, 'cache.write.lock');
  const host = hostname();
  let lockDepth = 0;
  let writeActive = false;
  let lockHandle = null;
  let lockHeartbeat = null;
  const lockContext = new AsyncLocalStorage();
  const lockToken = {};
  const LOCK_STALE_MS = 120000;
  /** Last committed rows: table -> Map(id -> JSON string or row tuple). */
  let prev = emptyPrev();
  /** Last committed content signature per card, used to avoid re-hashing unchanged text. */
  let prevTexts = new Map();
  let prevMeta = new Map();

  function emptyPrev() {
    return {
      folders: new Map(),
      decks: new Map(),
      chapters: new Map(),
      cards: new Map(),
      moves: new Map(),
      conflicts: new Map(),
      tasks: new Map(),
    };
  }

  function openDb() {
    const handle = new DatabaseSync(dbPath);
    handle.exec('PRAGMA journal_mode = DELETE');
    handle.exec('PRAGMA synchronous = NORMAL');
    handle.exec('PRAGMA foreign_keys = OFF');
    // Multiple DSH processes may share this cache; wait for a short writer
    // commit instead of failing immediately with SQLITE_BUSY.
    handle.exec('PRAGMA busy_timeout = 5000');
    return handle;
  }

  function cardTextColumnPresent(handle) {
    return handle
      .prepare('PRAGMA table_info(cards)')
      .all()
      .some((column) => String(column.name) === 'text');
  }

  /** v3 -> v4: add the derived plain-text column and backfill every card. */
  function migrateCardTextColumn(handle) {
    handle.exec('BEGIN IMMEDIATE');
    try {
      handle.exec("ALTER TABLE cards ADD COLUMN text TEXT NOT NULL DEFAULT ''");
      const rows = handle.prepare('SELECT id, content FROM cards').all();
      const update = handle.prepare('UPDATE cards SET text = ? WHERE id = ?');
      for (const row of rows) update.run(plainText(String(row.content)), String(row.id));
      handle.prepare("UPDATE meta SET value = '" + CACHE_VERSION + "' WHERE key = 'schema_version'").run();
      handle.exec('COMMIT');
    } catch (error) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  /**
   * Recompute every card's derived text when PLAIN_TEXT_VERSION changed (for
   * example after a plain-text algorithm fix). Idempotent and cheap: one indexed
   * scan of id/content, and the version marker makes later loads a no-op.
   */
  function refreshPlainText(handle) {
    const row = handle.prepare("SELECT value FROM meta WHERE key = 'plain_text_version'").get();
    if (row && String(row.value) === String(PLAIN_TEXT_VERSION)) return;
    handle.exec('BEGIN IMMEDIATE');
    try {
      const rows = handle.prepare('SELECT id, content FROM cards').all();
      const update = handle.prepare('UPDATE cards SET text = ? WHERE id = ?');
      for (const card of rows) update.run(plainText(String(card.content)), String(card.id));
      handle
        .prepare("INSERT INTO meta (key, value) VALUES ('plain_text_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(PLAIN_TEXT_VERSION));
      handle.exec('COMMIT');
      log('info', 'recomputed plain-text column for ' + rows.length + ' cards (algorithm v' + String(PLAIN_TEXT_VERSION) + ')');
    } catch (error) {
      try {
        handle.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    }
  }

  function ensureSchema(handle) {
    for (const sql of SCHEMA_SQL) handle.exec(sql);
    const row = handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
    if (!row) return null;
    let version = Number.parseInt(String(row.value), 10);
    if (!Number.isFinite(version)) return null;
    if (version === 3) {
      if (!cardTextColumnPresent(handle)) {
        migrateCardTextColumn(handle);
        log('info', 'cache schema upgraded v3 -> v4: added cards.text (plain-text search column)');
      } else {
        handle.prepare("UPDATE meta SET value = '" + CACHE_VERSION + "' WHERE key = 'schema_version'").run();
      }
      version = CACHE_VERSION;
    }
    if (version === CACHE_VERSION) refreshPlainText(handle);
    return version;
  }

  function collect() {
    const rows = emptyPrev();
    for (const [id, folder] of Object.entries(cache.folders)) rows.folders.set(id, JSON.stringify(folder));
    for (const [id, deck] of Object.entries(cache.decks)) rows.decks.set(id, JSON.stringify(deck));
    for (const [id, chapter] of Object.entries(cache.chapters)) rows.chapters.set(id, { deck_id: chapter.deck_id ?? null, data: JSON.stringify(chapter) });
    for (const [id, card] of Object.entries(cache.cards)) {
      const parts = cardContent(card);
      const signature = contentSignature(card);
      const old = prevTexts.get(id);
      const entry = {
        deck_id: card.deck_id ?? null,
        chapter_id: card.chapter_id ?? null,
        data: JSON.stringify(stripCard(card)),
        content: parts.content,
        text: plainText(parts.content),
        base: parts.base,
        pending: parts.pending,
        signature,
        hash: old === signature ? null : hashText(signature),
        bytes: Buffer.byteLength(parts.content, 'utf8') + (parts.base === null ? 0 : Buffer.byteLength(parts.base, 'utf8')) + (parts.pending === null ? 0 : Buffer.byteLength(parts.pending, 'utf8')),
      };
      const prior = rows.cards.get(id);
      void prior;
      rows.cards.set(id, entry);
    }
    for (const move of cache.moves) if (move && typeof move.id === 'string') rows.moves.set(move.id, JSON.stringify(move));
    for (const conflict of cache.conflicts) if (conflict && typeof conflict.id === 'string') rows.conflicts.set(conflict.id, JSON.stringify(conflict));
    for (const [id, task] of Object.entries(cache.tasks)) rows.tasks.set(id, JSON.stringify(task));

    const meta = new Map();
    meta.set('schema_version', String(CACHE_VERSION));
    meta.set('plain_text_version', String(PLAIN_TEXT_VERSION));
    meta.set('version', String(cache.version));
    meta.set('created_at', String(cache.created_at));
    for (const [key, value] of Object.entries(cache.meta)) meta.set('meta.' + key, JSON.stringify(value));
    return { rows, meta };
  }

  function insertRows(desired) {
    const insertSimple = {
      folders: db.prepare('INSERT INTO folders (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
      decks: db.prepare('INSERT INTO decks (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
      chapters: db.prepare('INSERT INTO chapters (id, deck_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET deck_id = excluded.deck_id, data = excluded.data'),
      cards: db.prepare('INSERT INTO cards (id, deck_id, chapter_id, data, content, text, base_content, pending_content, content_hash, content_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET deck_id = excluded.deck_id, chapter_id = excluded.chapter_id, data = excluded.data, content = excluded.content, text = excluded.text, base_content = excluded.base_content, pending_content = excluded.pending_content, content_hash = excluded.content_hash, content_bytes = excluded.content_bytes'),
      moves: db.prepare('INSERT INTO moves (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
      conflicts: db.prepare('INSERT INTO conflicts (id, data) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data'),
      tasks: db.prepare('INSERT INTO tasks (task_id, data) VALUES (?, ?) ON CONFLICT(task_id) DO UPDATE SET data = excluded.data'),
    };
    const deleteSimple = {
      folders: db.prepare('DELETE FROM folders WHERE id = ?'),
      decks: db.prepare('DELETE FROM decks WHERE id = ?'),
      chapters: db.prepare('DELETE FROM chapters WHERE id = ?'),
      cards: db.prepare('DELETE FROM cards WHERE id = ?'),
      moves: db.prepare('DELETE FROM moves WHERE id = ?'),
      conflicts: db.prepare('DELETE FROM conflicts WHERE id = ?'),
      tasks: db.prepare('DELETE FROM tasks WHERE task_id = ?'),
    };
    let touched = false;
    for (const table of Object.keys(insertSimple)) {
      const before = prev[table];
      const after = desired.rows[table];
      for (const [id, value] of after) {
        const old = before.get(id);
        let changed;
        if (table === 'cards') {
          changed = !old || old.data !== value.data || old.deck_id !== value.deck_id || old.chapter_id !== value.chapter_id || old.signature !== value.signature;
          if (changed) {
            if (value.hash === null) value.hash = hashText(value.signature);
            insertSimple.cards.run(id, value.deck_id, value.chapter_id, value.data, value.content, value.text, value.base, value.pending, value.hash, value.bytes);
            value.hash = null;
          }
        } else if (table === 'chapters') {
          changed = !old || old.data !== value.data || old.deck_id !== value.deck_id;
          if (changed) insertSimple.chapters.run(id, value.deck_id, value.data);
        } else {
          changed = old !== value;
          if (changed) insertSimple[table].run(id, value);
        }
        if (changed) touched = true;
      }
      for (const id of before.keys()) {
        if (!after.has(id)) {
          touched = true;
          deleteSimple[table].run(id);
        }
      }
    }
    return touched;
  }

  function insertMeta(desired) {
    let touched = false;
    for (const [key, value] of desired.meta) {
      const old = prevMeta.get(key);
      if (old !== value) {
        touched = true;
        db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
      }
    }
    for (const key of prevMeta.keys()) {
      if (!desired.meta.has(key)) {
        touched = true;
        db.prepare('DELETE FROM meta WHERE key = ?').run(key);
      }
    }
    return touched;
  }

  async function persist() {
    const desired = collect();
    db.exec('BEGIN IMMEDIATE');
    let touched = false;
    try {
      if (insertRows(desired)) touched = true;
      if (insertMeta(desired)) touched = true;
      db.exec(touched ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    }
    prev = desired.rows;
    prevMeta = desired.meta;
    prevTexts = new Map();
    let totalContent = 0;
    for (const [id, entry] of desired.rows.cards) {
      prevTexts.set(id, entry.signature);
      totalContent += entry.bytes;
    }
    contentBytes = totalContent;
    contentFiles = desired.rows.cards.size;
    try {
      dbBytes = (await fsp.stat(dbPath)).size;
    } catch {
      dbBytes = 0;
    }
    savedAt = clock();
    saveError = null;
    dirty = false;
    try {
      const info = await fsp.stat(dbPath);
      dbBytes = info.size;
      lastFileSize = info.size;
      lastFileMtimeMs = info.mtimeMs;
    } catch {
      /* stats are advisory */
    }
  }

  function scheduleSave() {
    dirty = true;
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      if (!loaded) return;
      saveNow().catch((error) => {
        saveError = error && error.message ? error.message : String(error);
        log('warn', 'cache save failed: ' + saveError);
      });
    }, debounceMs);
    if (typeof saveTimer.unref === 'function') saveTimer.unref();
  }

  async function quarantineLegacy(reason) {
    const target = join(dataDir, 'cache.' + reason + '-' + nowIso() + '.json');
    try {
      await renameWithRetry(fs, legacyPath, target);
      log('warn', 'legacy cache file ' + reason + '; moved to ' + target);
    } catch (error) {
      log('warn', 'legacy cache file ' + reason + ' but could not be moved: ' + (error && error.message ? error.message : String(error)));
    }
  }

  async function migrateLegacyJson() {
    let parsed = null;
    try {
      const raw = await fs.readFile(legacyPath, 'utf8');
      parsed = JSON.parse(raw);
    } catch (error) {
      if (error && error.code === 'ENOENT') return false;
      await quarantineLegacy('corrupt');
      return false;
    }
    if (!isObject(parsed) || (parsed.version !== 1 && parsed.version !== 2)) {
      await quarantineLegacy('v' + String(parsed && parsed.version) + '-backup');
      return false;
    }
    const startedAt = clock();
    cache = normalizeCache(parsed);
    prev = emptyPrev();
    prevTexts = new Map();
    prevMeta = new Map();
    clearAllRows();
    await persist();
    const target = join(dataDir, 'cache.imported-' + nowIso() + '.json');
    try {
      await renameWithRetry(fs, legacyPath, target);
    } catch (error) {
      log('warn', 'legacy cache imported but could not be renamed: ' + (error && error.message ? error.message : String(error)));
    }
    log('info', 'migrated cache.json -> cache.db: ' + Object.keys(cache.cards).length + ' cards, ' + String(clock() - startedAt) + ' ms');
    return true;
  }

  function clearAllRows() {
    for (const table of ['folders', 'decks', 'chapters', 'cards', 'moves', 'conflicts', 'tasks']) db.prepare('DELETE FROM ' + table).run();
    db.prepare('DELETE FROM meta').run();
  }

  /** Read the v2 layout (cache.db index + content/<deck>/<card>.txt) into memory. */
  function readV2Cache() {
    const legacyDb = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const metaMap = new Map(legacyDb.prepare('SELECT key, value FROM meta').all().map((row) => [String(row.key), String(row.value)]));
      const loaded = emptyCache();
      loaded.created_at = Number(metaMap.get('created_at')) || 0;
      for (const [key, value] of metaMap) {
        if (!key.startsWith('meta.')) continue;
        try {
          loaded.meta[key.slice('meta.'.length)] = JSON.parse(value);
        } catch {
          /* ignore */
        }
      }
      for (const row of legacyDb.prepare('SELECT id, data FROM folders').all()) loaded.folders[String(row.id)] = JSON.parse(row.data);
      for (const row of legacyDb.prepare('SELECT id, data FROM decks').all()) loaded.decks[String(row.id)] = JSON.parse(row.data);
      for (const row of legacyDb.prepare('SELECT id, data FROM chapters').all()) loaded.chapters[String(row.id)] = JSON.parse(row.data);
      for (const row of legacyDb.prepare('SELECT id, data FROM cards').all()) {
        const card = JSON.parse(row.data);
        card.content = '';
        if (isObject(card.cloud)) card.cloud.content = undefined;
        if (isObject(card.pending)) card.pending.content = undefined;
        loaded.cards[String(row.id)] = card;
      }
      for (const row of legacyDb.prepare('SELECT id, data FROM moves').all()) loaded.moves.push(JSON.parse(row.data));
      for (const row of legacyDb.prepare('SELECT id, data FROM conflicts').all()) loaded.conflicts.push(JSON.parse(row.data));
      for (const row of legacyDb.prepare('SELECT task_id, data FROM tasks').all()) loaded.tasks[String(row.task_id)] = JSON.parse(row.data);
      for (const row of legacyDb.prepare('SELECT card_id, kind, path FROM contents').all()) {
        const card = loaded.cards[String(row.card_id)];
        if (!card) continue;
        let text = '';
        try {
          text = readFileSync(String(row.path), 'utf8');
        } catch {
          log('warn', 'v2 content file missing during migration: ' + row.path);
        }
        if (row.kind === 'current') card.content = text;
        else if (row.kind === 'pending' && isObject(card.pending)) card.pending.content = text;
        else if (row.kind === 'base' && isObject(card.cloud)) card.cloud.content = text;
      }
      for (const card of Object.values(loaded.cards)) {
        if (isObject(card.cloud) && typeof card.cloud.content !== 'string') card.cloud.content = card.content;
      }
      return loaded;
    } finally {
      legacyDb.close();
    }
  }

  async function migrateV2() {
    const startedAt = clock();
    const old = readV2Cache();
    if (db !== null) {
      db.close();
      db = null;
    }
    const stamp = nowIso();
    try {
      await renameWithRetry(fs, dbPath, join(dataDir, 'cache.v2-backup-' + stamp + '.db'));
      log('warn', 'v2 cache database kept as cache.v2-backup-*.db');
    } catch (error) {
      log('warn', 'v2 cache database could not be renamed: ' + (error && error.message ? error.message : String(error)));
    }
    try {
      await renameWithRetry(fs, legacyContentDir, join(dataDir, 'content.v2-backup-' + stamp));
      log('warn', 'v2 content tree kept as content.v2-backup-*');
    } catch (error) {
      log('warn', 'v2 content tree could not be renamed: ' + (error && error.message ? error.message : String(error)));
    }
    db = openDb();
    ensureSchema(db);
    cache = normalizeCache(old);
    prev = emptyPrev();
    prevTexts = new Map();
    prevMeta = new Map();
    clearAllRows();
    await persist();
    log('info', 'migrated v2 cache.db + content/ -> v3 cache.db: ' + Object.keys(cache.cards).length + ' cards, ' + String(clock() - startedAt) + ' ms');
  }

  function hydrateRows() {
    const metaMap = new Map(db.prepare('SELECT key, value FROM meta').all().map((row) => [String(row.key), String(row.value)]));
    cache = emptyCache();
    cache.created_at = Number(metaMap.get('created_at')) || 0;
    for (const [key, value] of metaMap) {
      if (!key.startsWith('meta.')) continue;
      try {
        cache.meta[key.slice('meta.'.length)] = JSON.parse(value);
      } catch {
        /* ignore */
      }
    }
    for (const row of db.prepare('SELECT id, data FROM folders').all()) cache.folders[String(row.id)] = JSON.parse(row.data);
    for (const row of db.prepare('SELECT id, data FROM decks').all()) cache.decks[String(row.id)] = JSON.parse(row.data);
    for (const row of db.prepare('SELECT id, data FROM chapters').all()) cache.chapters[String(row.id)] = JSON.parse(row.data);
    for (const row of db.prepare('SELECT id, data, content, text, base_content, pending_content FROM cards').all()) {
      const card = JSON.parse(row.data);
      card.content = String(row.content);
      card.text = row.text === null || row.text === undefined || String(row.text) === '' ? plainText(card.content) : String(row.text);
      if (row.pending_content !== null && row.pending_content !== undefined && isObject(card.pending)) card.pending.content = String(row.pending_content);
      else if (isObject(card.pending)) card.pending.content = card.content;
      if (row.base_content !== null && row.base_content !== undefined && isObject(card.cloud)) card.cloud.content = String(row.base_content);
      else if (isObject(card.cloud)) card.cloud.content = card.content;
      cache.cards[String(row.id)] = card;
    }
    for (const row of db.prepare('SELECT id, data FROM moves').all()) cache.moves.push(JSON.parse(row.data));
    for (const row of db.prepare('SELECT id, data FROM conflicts').all()) cache.conflicts.push(JSON.parse(row.data));
    for (const row of db.prepare('SELECT task_id, data FROM tasks').all()) cache.tasks[String(row.task_id)] = JSON.parse(row.data);
    return metaMap;
  }

  function seedPrev() {
    prev = emptyPrev();
    for (const row of db.prepare('SELECT id, data FROM folders').all()) prev.folders.set(String(row.id), row.data);
    for (const row of db.prepare('SELECT id, data FROM decks').all()) prev.decks.set(String(row.id), row.data);
    for (const row of db.prepare('SELECT id, deck_id, data FROM chapters').all()) prev.chapters.set(String(row.id), { deck_id: row.deck_id, data: row.data });
    for (const row of db.prepare('SELECT id, deck_id, chapter_id, data, content, base_content, pending_content, content_hash, content_bytes FROM cards').all()) {
      const card = cache.cards[String(row.id)];
      prev.cards.set(String(row.id), {
        deck_id: row.deck_id,
        chapter_id: row.chapter_id,
        data: row.data,
        content: String(row.content),
        base: row.base_content === null || row.base_content === undefined ? null : String(row.base_content),
        pending: row.pending_content === null || row.pending_content === undefined ? null : String(row.pending_content),
        signature: card ? contentSignature(card) : '',
        hash: String(row.content_hash),
        bytes: Number(row.content_bytes) || 0,
      });
    }
    prevMeta = new Map(db.prepare('SELECT key, value FROM meta').all().map((row) => [String(row.key), String(row.value)]));
    prevTexts = new Map();
    let total = 0;
    for (const [id, entry] of prev.cards) {
      prevTexts.set(id, entry.signature);
      total += entry.bytes;
    }
    contentBytes = total;
    contentFiles = prev.cards.size;
  }

  async function backupAndReset(reason) {
    const target = join(dataDir, 'cache.' + reason + '-backup-' + nowIso() + '.db');
    try {
      db.close();
      db = null;
      await fs.cp(dbPath, target);
      await unlinkWithRetry(fs, dbPath);
      log('warn', 'cache ' + reason + ' is not ' + CACHE_VERSION + '; kept ' + target + ' and started fresh');
    } catch (error) {
      log('warn', 'cache ' + reason + ' mismatch but could not be backed up: ' + (error && error.message ? error.message : String(error)));
    }
    db = openDb();
    ensureSchema(db);
    cache = emptyCache();
    cache.created_at = clock();
    prev = emptyPrev();
    prevTexts = new Map();
    prevMeta = new Map();
    await persist();
  }

  async function recoverCorrupt(error) {
    log('warn', 'cache database unusable (' + (error && error.message ? error.message : String(error)) + '); starting fresh');
    try {
      if (db !== null) db.close();
    } catch {
      /* ignore */
    }
    db = null;
    const target = join(dataDir, 'cache.corrupt-' + nowIso() + '.db');
    try {
      await renameWithRetry(fs, dbPath, target);
      log('warn', 'corrupt cache database moved to ' + target);
    } catch (renameError) {
      log('warn', 'corrupt cache database could not be moved: ' + (renameError && renameError.message ? renameError.message : String(renameError)));
      try {
        await unlinkWithRetry(fs, dbPath);
      } catch {
        /* ignore */
      }
    }
    db = openDb();
    ensureSchema(db);
    cache = emptyCache();
    cache.created_at = clock();
    prev = emptyPrev();
    prevTexts = new Map();
    prevMeta = new Map();
    await persist();
  }

  async function fileExists(target) {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  async function hasSqliteHeader(target) {
    let handle = null;
    try {
      handle = await fs.open(target, 'r');
      const buffer = Buffer.alloc(16);
      const { bytesRead } = await handle.read(buffer, 0, 16, 0);
      return bytesRead === 16 && buffer.toString('latin1') === 'SQLite format 3\u0000';
    } catch {
      return false;
    } finally {
      if (handle !== null) {
        try {
          await handle.close();
        } catch {
          /* ignore */
        }
      }
    }
  }

  function dataVersion() {
    if (db === null) return null;
    try {
      const row = db.prepare('PRAGMA data_version').get();
      return row && row.data_version !== undefined ? Number(row.data_version) : null;
    } catch {
      return null;
    }
  }

  /** Restore stats for an existing database that was loaded rather than just saved. */
  async function refreshFileStats() {
    try {
      const info = await fsp.stat(dbPath);
      dbBytes = info.size;
      savedAt = info.mtimeMs;
      lastFileSize = info.size;
      lastFileMtimeMs = info.mtimeMs;
    } catch {
      dbBytes = 0;
    }
  }

  function cacheBusyError() {
    const error = new Error('cache is being written by another DSH process; retry shortly');
    error.code = 'cache_busy';
    error.hint = 'Another process or this profile instance is syncing or writing the cache. Retry after it finishes (markji_sync action=state shows the active task).';
    return error;
  }
  function processAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // EPERM means the process exists but belongs to another user.
      return Boolean(error && error.code === 'EPERM');
    }
  }
  async function lockLooksStale() {
    let meta = null;
    try {
      meta = JSON.parse(await fs.readFile(lockPath, 'utf8'));
    } catch {
      /* unreadable or removed: fall through to mtime */
    }
    if (meta !== null && meta.host === host && Number.isInteger(meta.pid) && !processAlive(meta.pid)) return true;
    try {
      const info = await fs.stat(lockPath);
      return Date.now() - info.mtimeMs > LOCK_STALE_MS;
    } catch {
      return true;
    }
  }
  async function acquireLock(timeoutMs, onWait) {
    const startedAt = Date.now();
    let notified = false;
    for (;;) {
      let handle = null;
      try {
        handle = await fs.open(lockPath, 'wx');
        await handle.writeFile(JSON.stringify({ pid: process.pid, host, at: clock() }));
        lockHandle = handle;
        lockHeartbeat = setInterval(() => {
          fs.utimes(lockPath, new Date(), new Date()).catch(() => {});
        }, 5000);
        if (typeof lockHeartbeat.unref === 'function') lockHeartbeat.unref();
        return;
      } catch (error) {
        if (handle !== null) {
          try {
            await handle.close();
          } catch {
            /* ignore */
          }
        }
        if (!error || error.code !== 'EEXIST') throw error;
        if (await lockLooksStale()) {
          try {
            await unlinkWithRetry(fs, lockPath);
          } catch {
            /* another waiter may have removed it */
          }
          continue;
        }
        if (!notified) {
          notified = true;
          if (typeof onWait === 'function') {
            try {
              onWait();
            } catch {
              /* advisory only */
            }
          }
        }
        if (Date.now() - startedAt >= timeoutMs) throw cacheBusyError();
        await sleep(75);
      }
    }
  }
  async function releaseLock() {
    if (lockHeartbeat !== null) {
      clearInterval(lockHeartbeat);
      lockHeartbeat = null;
    }
    if (lockHandle !== null) {
      const handle = lockHandle;
      lockHandle = null;
      try {
        await handle.close();
      } catch {
        /* ignore */
      }
    }
    try {
      await unlinkWithRetry(fs, lockPath);
    } catch {
      /* a stale lock will be reclaimed by the next writer */
    }
  }
  /**
   * Run fn while holding the cross-process writer lock. Nested calls in the same
   * store are reentrant (the event loop is single-threaded, so no interleaving
   * can happen inside one critical section).
   */
  async function withWriteLock(fn, options = {}) {
    // Nested calls from the same async operation (e.g. editCard -> lazy pull)
    // already own the lock; only concurrent operations must queue.
    if (lockContext.getStore() === lockToken) {
      lockDepth += 1;
      try {
        return await fn();
      } finally {
        lockDepth -= 1;
      }
    }
    const timeoutMs = Number.isFinite(options.timeoutMs) ? Math.max(0, options.timeoutMs) : 20000;
    const startedAt = Date.now();
    let notified = false;
    const notify = () => {
      if (notified) return;
      notified = true;
      if (typeof options.onWait === 'function') {
        try {
          options.onWait();
        } catch {
          /* advisory only */
        }
      }
    };
    while (writeActive) {
      notify();
      if (Date.now() - startedAt >= timeoutMs) throw cacheBusyError();
      await sleep(50);
    }
    writeActive = true;
    let acquired = false;
    try {
      await acquireLock(Math.max(0, timeoutMs - (Date.now() - startedAt)), notify);
      acquired = true;
      lockDepth = 1;
      return await lockContext.run(lockToken, fn);
    } finally {
      lockDepth = 0;
      writeActive = false;
      if (acquired) await releaseLock();
    }
  }
  /**
   * Reload the in-memory snapshot when another process committed a newer
   * cache.db. Callers that are about to mutate should run inside withWriteLock
   * so the reload+mutate+save sequence cannot race.
   */
  async function refreshIfChanged() {
    if (!loaded || db === null) return false;
    // A concurrent operation in this process is mid-mutation: the lock owner
    // refreshes explicitly before mutating; other contexts must not reload.
    if (writeActive && lockContext.getStore() !== lockToken) return false;
    const versionBefore = dataVersion();
    let before = null;
    try {
      before = await fs.stat(dbPath);
    } catch {
      /* missing file: treat as no external change */
    }
    const externalBefore =
      (before !== null && (before.size !== lastFileSize || before.mtimeMs !== lastFileMtimeMs)) ||
      (versionBefore !== null && lastDataVersion !== null && versionBefore !== lastDataVersion);
    if (dirty || saveTimer !== null) {
      // Persist this process's own queued changes before adopting a foreign snapshot.
      await saveNow();
    }
    try {
      await saveChain;
    } catch {
      return false;
    }
    let info;
    try {
      info = await fs.stat(dbPath);
    } catch {
      return false;
    }
    // If the file was already different before our own save, keep the reload even
    // though persist() refreshed the signature to our just-written file. Size +
    // mtime alone can miss two commits in the same millisecond, hence data_version.
    const versionAfter = dataVersion();
    const versionChanged =
      versionAfter !== null && lastDataVersion !== null && versionAfter !== lastDataVersion;
    if (!externalBefore && !versionChanged && info.size === lastFileSize && info.mtimeMs === lastFileMtimeMs) return false;
    db.exec('BEGIN');
    try {
      hydrateRows();
      seedPrev();
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* ignore */
      }
      throw error;
    }
    lastFileSize = info.size;
    lastFileMtimeMs = info.mtimeMs;
    lastDataVersion = dataVersion();
    dbBytes = info.size;
    savedAt = info.mtimeMs;
    loadedAt = clock();
    log('debug', 'cache reloaded after an external write: ' + Object.keys(cache.cards).length + ' cards');
    return true;
  }

  async function initialize() {
    const existed = await fileExists(dbPath);
    if (existed && !(await hasSqliteHeader(dbPath))) {
      // Opening a non-SQLite file keeps a native handle alive on Windows, so
      // quarantine by header check before ever constructing DatabaseSync.
      const target = join(dataDir, 'cache.corrupt-' + nowIso() + '.db');
      try {
        await renameWithRetry(fs, dbPath, target);
        log('warn', 'cache.db is not a SQLite file; moved to ' + target);
      } catch (error) {
        log('warn', 'cache.db is not a SQLite file and could not be moved: ' + (error && error.message ? error.message : String(error)));
        await unlinkWithRetry(fs, dbPath);
      }
    }
    const usable = await fileExists(dbPath);
    if (!usable) {
      db = openDb();
      ensureSchema(db);
      if (await fileExists(legacyPath)) {
        const imported = await migrateLegacyJson();
        if (!imported) {
          cache = emptyCache();
          cache.created_at = clock();
          await persist();
        }
      } else {
        cache = emptyCache();
        cache.created_at = clock();
        await persist();
      }
      loadedAt = clock();
      loaded = true;
      return cache;
    }
    db = openDb();
    let schemaVersion = ensureSchema(db);
    if (schemaVersion === CACHE_VERSION) {
      db.exec('BEGIN');
      try {
        hydrateRows();
        seedPrev();
        db.exec('COMMIT');
      } catch (error) {
        try {
          db.exec('ROLLBACK');
        } catch {
          /* ignore */
        }
        throw error;
      }
      await refreshFileStats();
      lastDataVersion = dataVersion();
      loadedAt = clock();
      loaded = true;
      log('info', 'cache loaded from ' + dbPath + ': ' + Object.keys(cache.cards).length + ' cards, ' + contentBytes + ' content bytes, ' + dbBytes + ' B db');
      return cache;
    }
    if (schemaVersion === 2) {
      await migrateV2();
      seedPrev();
      loadedAt = clock();
      loaded = true;
      return cache;
    }
    await backupAndReset(schemaVersion === null ? 'unknown' : 'v' + String(schemaVersion));
    loadedAt = clock();
    loaded = true;
    return cache;
  }

  async function load() {
    if (loaded) return cache;
    if (loadPromise !== null) return loadPromise;
    loadPromise = (async () => {
      await fs.mkdir(dataDir, { recursive: true });
      try {
        const fresh = await initialize();
        lastDataVersion = dataVersion();
        return fresh;
      } catch (error) {
        await recoverCorrupt(error);
        lastDataVersion = dataVersion();
        return cache;
      }
    })();
    try {
      return await loadPromise;
    } finally {
      loadPromise = null;
    }
  }

  function saveNow() {
    if (!loaded || db === null) return Promise.resolve();
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    const run = saveChain.then(() => persist()).catch((error) => {
      saveError = error && error.message ? error.message : String(error);
      throw error;
    });
    saveChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  function stats() {
    const cards = Object.values(cache.cards);
    const conflicts = cache.conflicts.filter((entry) => entry && entry.state === 'open');
    return {
      path: dbPath,
      data_dir: dataDir,
      bytes: dbBytes,
      db_bytes: dbBytes,
      content_bytes: contentBytes,
      content_files: contentFiles,
      decks: Object.keys(cache.decks).length,
      chapters: Object.keys(cache.chapters).length,
      cards: cards.length,
      conflicts: conflicts.length,
      dirtyCards: cards.filter((card) => card.pending || card.local).length,
      loadedAt,
      savedAt,
      saveError,
    };
  }

  return {
    get cache() {
      return cache;
    },
    get loaded() {
      return loaded;
    },
    get writeLocked() {
      return writeActive || lockDepth > 0;
    },
    path: dbPath,
    lock_path: lockPath,
    load,
    refreshIfChanged,
    withWriteLock,
    flush() {
      if (!loaded) return Promise.resolve();
      scheduleSave();
      return saveNow();
    },
    saveNow,
    markDirty: scheduleSave,
    stats,
    /** Close the SQLite handle (plugin teardown, tests on Windows). */
    async close() {
      if (lockDepth > 0) {
        lockDepth = 0;
        await releaseLock();
      }
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      try {
        await saveChain;
      } catch {
        /* ignore */
      }
      if (loaded && db !== null) {
        try {
          await persist();
        } catch (error) {
          saveError = error && error.message ? error.message : String(error);
        }
      }
      if (db !== null) {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        db = null;
      }
    },
    /** Replace the in-memory cache (used by tests and migrations). */
    replace(next) {
      cache = normalizeCache(next);
      if (!loaded) loaded = true;
      prev = emptyPrev();
      prevTexts = new Map();
      prevMeta = new Map();
      dirty = true;
      scheduleSave();
      return cache;
    },
  };
}