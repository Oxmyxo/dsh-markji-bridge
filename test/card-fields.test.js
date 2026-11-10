import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createEngine } from '../lib/sync.js';
import { registerTools } from '../lib/tools.js';

const rawContent = '  问题\r\n---\r\n[T#B#答案] [Pic#ID/mkjf_x#]\n' + '长正文 '.repeat(100) + '\t尾部  ';
const fields = ['id', 'content', 'deck_id', 'deck_name', 'chapter_id', 'chapter_name', 'status', 'text', 'snippet', 'grammar_version', 'revision', 'updated_time', 'created_time', 'local', 'pending', 'conflict', 'last_error', 'cloud'];
const keys = (value) => Object.keys(value).sort();
const invalid = (error) => error.code === 'invalid_argument';

async function withFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'markji-card-fields-'));
  const store = createStore({ dataDir: dir, log: () => {} });
  let engine;
  let dispose;
  let pulls = 0;
  try {
    await store.load();
    store.replace({
      version: 3, created_at: 1,
      meta: { last_pull_at: Date.now(), last_full_pull_at: 1, last_push_at: null, last_sync: null, last_error: null, conflict_seq: 0 },
      folders: {},
      decks: { d1: { id: 'd1', name: '卡组', chapter_ids: ['c1'], card_count: 2 } },
      chapters: { c1: { id: 'c1', deck_id: 'd1', name: '章节', card_ids: ['k1', 'k2'] } },
      cards: {
        k1: { id: 'k1', deck_id: 'd1', chapter_id: 'c1', content: rawContent, grammar_version: 3, updated_time: '2026-10-01T00:00:00Z', cloud: { revision: 7, updated_time: '2026-10-01T00:00:00Z', content: rawContent } },
        k2: { id: 'k2', deck_id: 'd1', chapter_id: 'c1', content: '', grammar_version: 3 },
      },
      conflicts: [], moves: [], tasks: {},
    });
    await store.saveNow();
    engine = createEngine({
      client: {
        async listFolders() { pulls += 1; throw new Error('offline fixture: keep cached records'); },
        async listAllDecks() { return []; },
      },
      store, config: { autoSync: false, pullTtlMs: 86400000, grammarVersion: 3 }, log: () => {},
    });
    await engine.ready();
    const registered = new Map();
    dispose = registerTools({ tools: { register(tool) { registered.set(tool.name, tool); return () => {}; } } }, { engine, config: { maxOutputChars: 20000 } });
    await run({ engine, store, tool: registered.get('markji_cards'), pulls: () => pulls });
  } finally {
    dispose?.();
    if (engine) await engine.stop();
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
}

test('engine list/getCard/getCards default to exactly id/content and preserve raw content', async () => {
  await withFixture(async ({ engine }) => {
    for (const args of [{}, { include_fields: [] }, { include_fields: ['id', 'content', 'id'] }, { include_text: false }]) {
      const listed = await engine.listCards(args);
      assert.deepEqual(listed.cards, [{ id: 'k1', content: rawContent }, { id: 'k2', content: '' }]);
      const single = await engine.getCard({ card: 'k1', ...args });
      assert.deepEqual(single, { card: { id: 'k1', content: rawContent } });
      const multi = await engine.getCards({ cards: ['k2', 'k1', 'k2'], ...args });
      assert.deepEqual(multi, { cards: [{ id: 'k2', content: '' }, { id: 'k1', content: rawContent }] });
    }
  });
});

test('tool list and get, with single or multiple ids, use the same minimal default', async () => {
  await withFixture(async ({ tool }) => {
    const listed = await tool.execute({ action: 'list' });
    assert.deepEqual(listed.cards, [{ id: 'k1', content: rawContent }, { id: 'k2', content: '' }]);
    assert.deepEqual(await tool.execute({ action: 'get', card: 'k1' }), { cards: [{ id: 'k1', content: rawContent }] });
    assert.deepEqual(await tool.execute({ action: 'get', cards: ['k2', 'k1', 'k2'] }), {
      cards: [{ id: 'k2', content: '' }, { id: 'k1', content: rawContent }],
    });
  });
});

test('include_fields adds only requested fields, deduplicates and always retains id/content', async () => {
  await withFixture(async ({ engine, tool }) => {
    const include_fields = ['status', 'deck_name', 'deck_name', 'id', 'content'];
    for (const read of [
      () => engine.listCards({ include_fields }),
      () => engine.getCards({ cards: ['k1'], include_fields }),
      () => tool.execute({ action: 'list', include_fields }),
      () => tool.execute({ action: 'get', card: 'k1', include_fields }),
      () => tool.execute({ action: 'get', cards: ['k1'], include_fields }),
    ]) {
      const { cards } = await read();
      assert.deepEqual(cards[0], { id: 'k1', content: rawContent, status: 'synced', deck_name: '卡组' });
    }
    const single = await engine.getCard({ card: 'k1', include_fields: fields });
    assert.deepEqual(keys(single.card), [...fields].sort());
    assert.equal(single.card.deck_id, 'd1');
    assert.equal(single.card.chapter_id, 'c1');
    assert.equal(single.card.chapter_name, '章节');
    assert.equal(single.card.revision, 7);
    assert.equal(single.card.grammar_version, 3);
    assert.equal(single.card.updated_time, '2026-10-01T00:00:00Z');
    assert.equal(single.card.content, rawContent);
    assert.match(single.card.text, /答案/);
    assert.doesNotMatch(single.card.text, /T#B#|Pic#ID/);
    assert.ok(single.card.snippet.length < rawContent.length);
    assert.deepEqual(single.card.cloud, { revision: 7, updated_time: '2026-10-01T00:00:00Z' });
    for (const card of [single.card, (await engine.listCards({ include_fields: fields })).cards[1]]) {
      assert.equal(card.local, false);
      for (const name of ['created_time', 'pending', 'conflict', 'last_error']) assert.equal(card[name], null, name);
    }
    const sparse = (await engine.getCard({ card: 'k2', include_fields: fields })).card;
    assert.deepEqual(keys(sparse), [...fields].sort());
    assert.equal(sparse.cloud, null);
    assert.equal(sparse.revision, null);
    assert.equal(sparse.updated_time, null);
    assert.deepEqual(include_fields, ['status', 'deck_name', 'deck_name', 'id', 'content']);
  });
});

test('include_text remains an additive alias and false cannot remove explicit text', async () => {
  await withFixture(async ({ engine, tool }) => {
    for (const read of [
      (args) => engine.getCard({ card: 'k1', ...args }).then(({ card }) => card),
      (args) => engine.getCards({ cards: ['k1'], ...args }).then(({ cards }) => cards[0]),
      (args) => engine.listCards(args).then(({ cards }) => cards[0]),
      (args) => tool.execute({ action: 'get', cards: ['k1'], ...args }).then(({ cards }) => cards[0]),
      (args) => tool.execute({ action: 'list', ...args }).then(({ cards }) => cards[0]),
    ]) {
      assert.deepEqual(keys(await read({ include_text: true })), ['content', 'id', 'text']);
      assert.deepEqual(keys(await read({ include_fields: ['text'], include_text: false })), ['content', 'id', 'text']);
      assert.deepEqual(keys(await read({ include_fields: ['status', 'text'], include_text: true })), ['content', 'id', 'status', 'text']);
    }
  });
});

test('projection leaves filtering, pagination, empty hints and missing envelopes unchanged', async () => {
  await withFixture(async ({ engine, tool, pulls }) => {
    const page = await engine.listCards({ limit: 1, offset: 1 });
    assert.deepEqual(page, { total: 2, offset: 1, limit: 1, has_more: false, cards: [{ id: 'k2', content: '' }] });
    const first = await tool.execute({ action: 'list', limit: 1, include_fields: ['status'] });
    assert.deepEqual({ total: first.total, offset: first.offset, limit: first.limit, has_more: first.has_more }, { total: 2, offset: 0, limit: 1, has_more: true });
    const hit = await engine.listCards({ filter: { all: [{ field: 'deck_name', op: 'eq', value: '卡组' }, { field: 'revision', op: 'eq', value: 7 }] } });
    assert.deepEqual(hit.cards, [{ id: 'k1', content: rawContent }]);
    const empty = await engine.listCards({ filter: { field: 'id', op: 'eq', value: 'none' } });
    assert.deepEqual(keys(empty), ['cards', 'has_more', 'hint', 'limit', 'offset', 'total']);
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.cards, []);
    const marker = pulls();
    assert.deepEqual(await engine.getCards({ cards: ['missing', 'k1', 'missing'] }), { cards: [{ id: 'k1', content: rawContent }], missing: ['missing'] });
    assert.equal(pulls() - marker, 1, 'one cheap refresh for the batch miss');
    assert.deepEqual(await tool.execute({ action: 'get', cards: ['missing', 'k2'], include_fields: ['local'] }), { cards: [{ id: 'k2', content: '', local: false }], missing: ['missing'] });
    await assert.rejects(engine.getCard({ card: 'missing' }), (error) => error.code === 'unknown_card');
  });
});

test('invalid include_fields/include_text reject in engine and tools, including empty results', async () => {
  await withFixture(async ({ engine, tool }) => {
    const badArgs = [null, 'text', {}, 1, true, [null], [1], [[]], [{}], [''], [' text'], ['TEXT'], ['cloud.revision'], ['__proto__'], ['constructor'], ['prototype'], ['unknown'], ['status', 'unknown']].map((include_fields) => ({ include_fields }));
    badArgs.push(...[null, 'true', 1, {}, []].map((include_text) => ({ include_text })));
    for (const args of badArgs) {
      for (const read of [
        () => engine.listCards({ filter: { field: 'id', op: 'eq', value: 'none' }, ...args }),
        () => engine.getCard({ card: 'k1', ...args }),
        () => engine.getCards({ cards: ['k1'], ...args }),
      ]) await assert.rejects(read(), invalid, JSON.stringify(args));
      for (const action of ['list', 'get']) {
        await assert.rejects(tool.execute({ action, card: 'k1', ...args }), /invalid_argument/, JSON.stringify(args));
      }
    }
  });
});

test('minimal and selected reads do not mutate cached records or later read results', async () => {
  await withFixture(async ({ engine, store, tool, pulls }) => {
    const before = structuredClone(store.cache);
    const selected = (await engine.getCard({ card: 'k1', include_fields: fields })).card;
    await engine.listCards({});
    await engine.getCards({ cards: ['k1', 'k2'] });
    await tool.execute({ action: 'get', cards: ['k1'] });
    await tool.execute({ action: 'list', include_fields: ['status'] });
    const after = (await engine.getCard({ card: 'k1', include_fields: fields })).card;
    assert.deepEqual(after, selected);
    assert.deepEqual(store.cache, before);
    assert.equal(pulls(), 0, 'fresh cached reads do not call the provider');
    assert.equal(store.cache.cards.k1.cloud.content, rawContent);
  });
});
