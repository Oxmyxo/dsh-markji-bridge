import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createStore, CACHE_VERSION } from '../lib/store.js';
import { createEngine } from '../lib/sync.js';
import { plainText } from '../lib/plain-text.js';

const BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('plainText strips formatting tags but keeps the visible text', () => {
  assert.equal(plainText('[T#B#加粗] 普通 [T#I,!e53935#红色]'), '加粗 普通 红色');
  assert.equal(plainText('H[T#down#2]O 与 x[T#up#2]'), 'H2O 与 x2');
  assert.equal(plainText('挖空 [F#1#答案] 之后'), '挖空 答案 之后');
  assert.equal(plainText('[P#H1#标题]\n[P#L#列表项]'), '标题\n列表项');
  assert.equal(plainText('[E##x^2 + y^2]'), 'x^2 + y^2');
  assert.equal(plainText('[Card#ID/abc-def#查看相关卡片]'), '查看相关卡片');
  assert.equal(plainText('[Audio#D,ID/abc#听这段]'), '听这段');
  assert.equal(plainText('开头 [Pic#ID/mkjf_x#] 结尾'), '开头  结尾');
});

test('plainText drops media, data URIs and base64 payloads', () => {
  assert.equal(plainText('图片 ![图](data:image/png;base64,' + BASE64 + ') 之后'), '图片 图 之后');
  assert.equal(plainText('前缀 data:image/png;base64,' + BASE64 + ' 后缀'), '前缀  后缀');
  // A bare base64 blob long enough to matter is treated as media, not text.
  assert.equal(plainText('前缀 ' + 'A'.repeat(200) + ' 后缀'), '前缀  后缀');
  // Short code-like tokens are kept.
  assert.equal(plainText('uint8_t a = 0xFF;'), 'uint8_t a = 0xFF;');
});

test('plainText does not confuse Markji style tags with Markdown links', () => {
  // A styled run followed by parentheses is code, not a Markdown link: the
  // "T#B#" prefix must never survive into the searchable text.
  assert.equal(plainText('size_t pos = str.[T#B#find](sub);'), 'size_t pos = str.find(sub);');
  assert.equal(plainText('[T#B#查看](详情) 文档'), '查看(详情) 文档');
  // Real Markdown links still keep their label only.
  assert.equal(plainText('参见 [文档](https://example.com/a)'), '参见 文档');
});

test('plainText keeps code, escaped brackets and choice options', () => {
  assert.equal(
    plainText('#include <cmath>\nint res = pow(3, 4);'),
    '#include <cmath>\nint res = pow(3, 4);',
  );
  assert.equal(plainText('保留 \\[ 方括号 \\]'), '保留 [ 方括号 ]');
  assert.equal(plainText('[Choice#fixed,multi#\n* 正确选项\n- 错误选项\n]'), '正确选项\n错误选项');
  assert.equal(plainText('问题\n---\n答案'), '问题\n\n答案');
});

function fixtureCache() {
  const cloud = (content) => ({ revision: 1, updated_time: '2024-09-22T13:15:50.120Z', content });
  const rich = '问题\n---\n[T#B#答案] [Pic#ID/mkjf_x#] ![图](data:image/png;base64,' + BASE64 + ') 关键词';
  return {
    version: 3,
    created_at: 1,
    meta: { last_pull_at: Date.now(), last_full_pull_at: 1, last_push_at: null, last_sync: null, last_error: null, conflict_seq: 0 },
    folders: {},
    decks: { d1: { id: 'd1', name: 'C/C++', chapter_ids: ['c1'], card_count: 2 } },
    chapters: { c1: { id: 'c1', deck_id: 'd1', name: '基础', card_ids: ['k1', 'k2'] } },
    cards: {
      k1: { id: 'k1', deck_id: 'd1', chapter_id: 'c1', content: rich, grammar_version: 3, cloud: cloud(rich) },
      k2: { id: 'k2', deck_id: 'd1', chapter_id: 'c1', content: '纯文本卡片', grammar_version: 3, cloud: cloud('纯文本卡片') },
    },
    conflicts: [],
    moves: [],
    tasks: {},
  };
}

test('search and card views use plain text, not base64 or formatting tags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-plain-'));
  const store = createStore({ dataDir: dir, log: () => {} });
  await store.load();
  store.replace(fixtureCache());
  await store.saveNow();
  const engine = createEngine({
    client: { listAllDecks: async () => ({ decks: [], folders: [] }) },
    store,
    config: { autoSync: false, pullTtlMs: 86400000 },
    log: () => {},
  });
  await engine.ready();
  try {
    for (const query of ['base64', 'iVBORw0', 'T#B#', 'Pic#ID']) {
      assert.equal((await engine.listCards({ query })).total, 0, 'query must not match media/markup: ' + query);
      assert.equal((await engine.listCards({ query })).total, 0, 'listCards must not match media/markup: ' + query);
    }
    const hit = await engine.listCards({ query: '关键词' });
    assert.equal(hit.total, 1);
    assert.equal(hit.cards[0].id, 'k1');
    assert.doesNotMatch(hit.cards[0].snippet, /base64|T#B#|Pic#ID/);
    const listed = await engine.listCards({ query: '答案' });
    assert.equal(listed.total, 1);
    assert.doesNotMatch(listed.cards[0].snippet, /base64|T#B#|Pic#ID/);
    const detail = await engine.getCard({ card: 'k1' });
    assert.equal(detail.card.text, '问题\n\n答案  图 关键词');
    assert.match(detail.card.content, /data:image\/png;base64,/);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the cards.text column stores the derived plain text and is not duplicated in data JSON', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-textcol-'));
  const store = createStore({ dataDir: dir, log: () => {} });
  await store.load();
  store.replace(fixtureCache());
  await store.saveNow();
  try {
    const db = new DatabaseSync(join(dir, 'cache.db'), { readOnly: true });
    try {
      const row = db.prepare('SELECT content, text, data FROM cards WHERE id = ?').get('k1');
      assert.equal(row.content, fixtureCache().cards.k1.content);
      assert.equal(row.text, plainText(row.content));
      assert.doesNotMatch(row.text, /base64|T#B#|Pic#ID/);
      assert.equal(JSON.parse(row.data).text, undefined);
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      assert.equal(version.value, String(CACHE_VERSION));
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('opening a v3 cache adds the text column and backfills every card', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-v3-text-'));
  const legacy = new DatabaseSync(join(dir, 'cache.db'));
  legacy.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  legacy.exec('CREATE TABLE folders (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  legacy.exec('CREATE TABLE decks (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  legacy.exec('CREATE TABLE chapters (id TEXT PRIMARY KEY, deck_id TEXT, data TEXT NOT NULL)');
  legacy.exec('CREATE TABLE cards (id TEXT PRIMARY KEY, deck_id TEXT, chapter_id TEXT, data TEXT NOT NULL, content TEXT NOT NULL, base_content TEXT, pending_content TEXT, content_hash TEXT NOT NULL, content_bytes INTEGER NOT NULL)');
  legacy.exec('CREATE TABLE moves (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  legacy.exec('CREATE TABLE conflicts (id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  legacy.exec('CREATE TABLE tasks (task_id TEXT PRIMARY KEY, data TEXT NOT NULL)');
  const raw = '旧问题\n---\n[T#B#旧答案]';
  const card = {
    id: 'k1',
    deck_id: 'd1',
    chapter_id: 'c1',
    grammar_version: 3,
    data: JSON.stringify({ id: 'k1', deck_id: 'd1', chapter_id: 'c1', grammar_version: 3 }),
    cloud: { revision: 1, updated_time: '2024-09-22T13:15:50.120Z' },
  };
  legacy.prepare('INSERT INTO meta VALUES (?, ?)').run('schema_version', '3');
  legacy.prepare('INSERT INTO meta VALUES (?, ?)').run('created_at', '1');
  legacy.prepare('INSERT INTO decks VALUES (?, ?)').run('d1', JSON.stringify({ id: 'd1', name: '旧卡组', chapter_ids: ['c1'], card_count: 1 }));
  legacy.prepare('INSERT INTO chapters VALUES (?, ?, ?)').run('c1', 'd1', JSON.stringify({ id: 'c1', deck_id: 'd1', name: '旧章节', card_ids: ['k1'] }));
  legacy.prepare('INSERT INTO cards VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    'k1', 'd1', 'c1', JSON.stringify(card), raw, raw, null,
    'a'.repeat(64), Buffer.byteLength(raw),
  );
  legacy.close();

  const store = createStore({ dataDir: dir, log: () => {} });
  try {
    await store.load();
    assert.equal(store.cache.cards.k1.content, raw);
    assert.equal(store.cache.cards.k1.text, '旧问题\n\n旧答案');
    const db = new DatabaseSync(join(dir, 'cache.db'), { readOnly: true });
    try {
      const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
      assert.equal(version.value, String(CACHE_VERSION));
      const row = db.prepare('SELECT text FROM cards WHERE id = ?').get('k1');
      assert.equal(row.text, '旧问题\n\n旧答案');
    } finally {
      db.close();
    }
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stale plain_text_version recomputes cards.text on the next load', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-plain-version-'));
  const first = createStore({ dataDir: dir, log: () => {} });
  await first.load();
  first.replace(fixtureCache());
  await first.saveNow();
  await first.close();
  // Simulate a cache produced by an older plain-text algorithm: wrong text and
  // a stale algorithm marker. The next load must repair every row in place.
  const db = new DatabaseSync(join(dir, 'cache.db'));
  try {
    db.prepare('UPDATE cards SET text = ? WHERE id = ?').run('旧算法残留 [T#B#]', 'k1');
    db.prepare("UPDATE meta SET value = '1' WHERE key = 'plain_text_version'").run();
  } finally {
    db.close();
  }
  const second = createStore({ dataDir: dir, log: () => {} });
  try {
    await second.load();
    assert.equal(second.cache.cards.k1.text, '问题\n\n答案  图 关键词');
    const check = new DatabaseSync(join(dir, 'cache.db'), { readOnly: true });
    try {
      const marker = check.prepare("SELECT value FROM meta WHERE key = 'plain_text_version'").get();
      assert.ok(marker && Number(marker.value) >= 2);
      const row = check.prepare('SELECT text FROM cards WHERE id = ?').get('k1');
      assert.equal(row.text, '问题\n\n答案  图 关键词');
    } finally {
      check.close();
    }
  } finally {
    await second.close();
    await rm(dir, { recursive: true, force: true });
  }
});
