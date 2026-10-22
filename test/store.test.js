import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, CACHE_VERSION } from '../lib/store.js';

async function tempDir(label) {
  return mkdtemp(join(tmpdir(), 'markji-store-' + label + '-'));
}
function readMeta(dir, key) {
  const db = new DatabaseSync(join(dir, 'cache.db'), { readOnly: true });
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
    return row ? row.value : null;
  } finally {
    db.close();
  }
}
function cardRow(dir, id) {
  const db = new DatabaseSync(join(dir, 'cache.db'), { readOnly: true });
  try {
    return db.prepare('SELECT content, base_content, pending_content, content_hash FROM cards WHERE id = ?').get(id) ?? null;
  } finally {
    db.close();
  }
}
function fixtureCard(overrides = {}) {
  return {
    id: 'mkjc_one',
    deck_id: 'mkjd_one',
    chapter_id: 'mkjch_one',
    content: '列表初始化',
    grammar_version: 3,
    cloud: { revision: 3, updated_time: '2026-10-01T00:00:00.000Z', content: '列表初始化' },
    updated_time: '2026-10-01T00:00:00.000Z',
    ...overrides,
  };
}
function fixtureCache(card = fixtureCard()) {
  return {
    version: 1,
    created_at: 1,
    meta: { last_pull_at: 1, last_full_pull_at: 1, last_push_at: null, last_sync: null, last_error: null, conflict_seq: 0 },
    folders: {},
    decks: { mkjd_one: { id: 'mkjd_one', name: 'C/C++', chapter_ids: ['mkjch_one'], card_count: 1 } },
    chapters: { mkjch_one: { id: 'mkjch_one', deck_id: 'mkjd_one', name: '初始化', card_ids: [card.id] } },
    cards: { [card.id]: card },
    conflicts: [],
    moves: [],
    tasks: {},
  };
}

test('fresh cache.db stores the index and card content in one file', async () => {
  const dir = await tempDir('fresh');
  const store = createStore({ dataDir: dir, log: () => {} });
  try {
    await store.load();
    store.cache.decks.mkjd_one = fixtureCache().decks.mkjd_one;
    store.cache.chapters.mkjch_one = fixtureCache().chapters.mkjch_one;
    store.cache.cards.mkjc_one = fixtureCard();
    await store.saveNow();
    assert.equal(readMeta(dir, 'schema_version'), String(CACHE_VERSION));
    const row = cardRow(dir, 'mkjc_one');
    assert.equal(row.content, '列表初始化');
    assert.match(row.content_hash, /^[0-9a-f]{64}$/);
    const stats = store.stats();
    assert.equal(stats.cards, 1);
    assert.equal(stats.content_bytes, Buffer.byteLength('列表初始化'));
    assert.equal(stats.path, join(dir, 'cache.db'));
    await store.close();
    const reloaded = createStore({ dataDir: dir });
    await reloaded.load();
    try {
      assert.equal(reloaded.cache.cards.mkjc_one.content, '列表初始化');
      assert.equal(reloaded.cache.cards.mkjc_one.cloud.content, '列表初始化');
    } finally {
      await reloaded.close();
    }
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy cache.json v1 is imported and archived', async () => {
  const dir = await tempDir('json');
  await writeFile(join(dir, 'cache.json'), JSON.stringify(fixtureCache(fixtureCard({ pending: { content: '待推送内容', grammar_version: 3 } }))), 'utf8');
  const store = createStore({ dataDir: dir, log: () => {} });
  try {
    await store.load();
    assert.equal(store.cache.cards.mkjc_one.content, '列表初始化');
    assert.equal(store.cache.cards.mkjc_one.pending.content, '待推送内容');
    const row = cardRow(dir, 'mkjc_one');
    assert.equal(row.pending_content, '待推送内容');
    const files = await readdir(dir);
    assert.equal(files.includes('cache.json'), false, 'legacy json moved aside');
    assert.ok(files.some((name) => name.startsWith('cache.imported-')));
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('v2 cache.db + content/ is migrated into the single v3 database', async () => {
  const dir = await tempDir('v2');
  await mkdir(join(dir, 'content', 'mkjd_one'), { recursive: true });
  await writeFile(join(dir, 'content', 'mkjd_one', 'mkjc_one.txt'), '列表初始化', 'utf8');
  const legacy = new DatabaseSync(join(dir, 'cache.db'));
  legacy.exec("CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  legacy.exec("CREATE TABLE folders (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  legacy.exec("CREATE TABLE decks (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  legacy.exec("CREATE TABLE chapters (id TEXT PRIMARY KEY, deck_id TEXT, data TEXT NOT NULL)");
  legacy.exec("CREATE TABLE cards (id TEXT PRIMARY KEY, deck_id TEXT, chapter_id TEXT, data TEXT NOT NULL)");
  legacy.exec("CREATE TABLE contents (card_id TEXT, kind TEXT, path TEXT, hash TEXT, bytes INTEGER)");
  legacy.exec("CREATE TABLE moves (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  legacy.exec("CREATE TABLE conflicts (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  legacy.exec("CREATE TABLE tasks (task_id TEXT PRIMARY KEY, data TEXT NOT NULL)");
  const cache = fixtureCache();
  delete cache.cards.mkjc_one.cloud.content;
  legacy.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', '2');
  legacy.prepare('INSERT INTO meta VALUES (?, ?)').run('meta.last_pull_at', '1');
  legacy.prepare('INSERT INTO decks VALUES (?, ?)').run('mkjd_one', JSON.stringify(cache.decks.mkjd_one));
  legacy.prepare('INSERT INTO chapters VALUES (?, ?, ?)').run('mkjch_one', 'mkjd_one', JSON.stringify(cache.chapters.mkjch_one));
  legacy.prepare('INSERT INTO cards VALUES (?, ?, ?, ?)').run('mkjc_one', 'mkjd_one', 'mkjch_one', JSON.stringify(cache.cards.mkjc_one));
  legacy.prepare('INSERT INTO contents VALUES (?, ?, ?, ?, ?)').run('mkjc_one', 'current', join(dir, 'content', 'mkjd_one', 'mkjc_one.txt'), 'x', 5);
  legacy.close();
  const store = createStore({ dataDir: dir, log: () => {} });
  try {
    await store.load();
    assert.equal(store.cache.cards.mkjc_one.content, '列表初始化');
    assert.equal(cardRow(dir, 'mkjc_one').content, '列表初始化');
    const files = await readdir(dir);
    assert.ok(files.some((name) => name.startsWith('cache.v2-backup-')), files.join(','));
    assert.ok(files.some((name) => name.startsWith('content.v2-backup-')), files.join(','));
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a corrupt cache.db is quarantined and replaced', async () => {
  const dir = await tempDir('corrupt');
  await writeFile(join(dir, 'cache.db'), 'this is not a sqlite database', 'utf8');
  const store = createStore({ dataDir: dir, log: () => {} });
  try {
    await store.load();
    assert.equal(store.stats().cards, 0);
    const files = await readdir(dir);
    assert.ok(files.some((name) => name.startsWith('cache.corrupt-')), files.join(','));
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('unchanged content keeps its hash and a change updates only that row', async () => {
  const dir = await tempDir('diff');
  const store = createStore({ dataDir: dir, log: () => {} });
  try {
    await store.load();
    store.cache.decks = fixtureCache().decks;
    store.cache.chapters = fixtureCache().chapters;
    store.cache.cards = fixtureCache().cards;
    await store.saveNow();
    const before = cardRow(dir, 'mkjc_one');
    store.cache.cards.mkjc_one.content = '列表初始化（改）';
    await store.saveNow();
    const after = cardRow(dir, 'mkjc_one');
    assert.match(after.content_hash, /^[0-9a-f]{64}$/);
    assert.notEqual(after.content_hash, before.content_hash);
    assert.equal(after.content, '列表初始化（改）');
    assert.equal(before.base_content, null, 'identical cloud content stores no base copy');
    assert.equal(after.base_content, '列表初始化', 'cloud snapshot kept only when it differs from the edited content');
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
