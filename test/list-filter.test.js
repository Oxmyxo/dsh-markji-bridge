import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStore } from '../lib/store.js';
import { createEngine } from '../lib/sync.js';

const noopClient = { listAllDecks: async () => ({ decks: [], folders: [] }) };

function fixtureCache() {
  return {
    version: 3,
    created_at: 1,
    meta: { last_pull_at: Date.now(), last_full_pull_at: 1, last_push_at: null, last_sync: null, last_error: null, conflict_seq: 0 },
    folders: {},
    decks: {
      d1: { id: 'd1', name: 'C/C++', description: '系统编程与内存管理', chapter_ids: ['c1'], card_count: 2, updated_time: '2026-05-01T00:00:00.000Z' },
      d2: { id: 'd2', name: 'STM32 协议', description: '嵌入式外设协议', chapter_ids: ['c2'], card_count: 1, updated_time: '2026-05-03T00:00:00.000Z' },
    },
    chapters: {
      c1: { id: 'c1', deck_id: 'd1', name: '初始化', revision: 1, order: 1, updated_time: '2026-04-01T00:00:00.000Z', card_ids: ['k1', 'k2'] },
      c2: { id: 'c2', deck_id: 'd2', name: 'SPI', revision: 2, order: 2, updated_time: '2026-04-02T00:00:00.000Z', card_ids: ['k3'] },
    },
    cards: {
      k1: { id: 'k1', deck_id: 'd1', chapter_id: 'c1', content: '建议的变量初始化方式: 列表初始化', grammar_version: 3, updated_time: '2024-09-22T13:15:50.120Z', cloud: { revision: 1, updated_time: '2024-09-22T13:15:50.120Z', content: '建议的变量初始化方式: 列表初始化' } },
      k2: { id: 'k2', deck_id: 'd1', chapter_id: 'c1', content: '指针与引用的区别', updated_time: '2026-10-18T15:26:06.381Z', cloud: { revision: 1, updated_time: '2026-10-18T15:26:06.381Z', content: '指针与引用的区别' } },
      k3: { id: 'k3', deck_id: 'd2', chapter_id: 'c2', content: 'SPI 时钟极性与相位', updated_time: '2026-10-19T10:00:00.000Z', cloud: { revision: 1, updated_time: '2026-10-19T10:00:00.000Z', content: 'SPI 时钟极性与相位' } },
    },
    conflicts: [],
    moves: [],
    tasks: {},
  };
}

async function makeEngine(dir) {
  const store = createStore({ dataDir: dir, log: () => {} });
  await store.load();
  store.replace(fixtureCache());
  await store.saveNow();
  const engine = createEngine({ client: noopClient, store, config: { autoSync: false, pullTtlMs: 86400000 }, log: () => {} });
  await engine.ready();
  return { store, engine };
}

test('markji_cards list supports scope, fields, predicate and combined filters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-filter-'));
  const { store, engine } = await makeEngine(dir);
  try {
    const byDeckScope = await engine.listCards({ scope: 'deck', deck: 'd1' });
    assert.deepEqual(byDeckScope.cards.map((card) => card.id), ['k1', 'k2']);
    const byChapterScope = await engine.listCards({ scope: 'chapter', chapter: 'c2' });
    assert.deepEqual(byChapterScope.cards.map((card) => card.id), ['k3']);
    await assert.rejects(engine.listCards({ scope: 'all', deck: 'd1' }), /scope=all/);
    await assert.rejects(engine.listCards({ scope: 'deck' }), /requires deck/);
    await assert.rejects(engine.listCards({ scope: 'chapter' }), /requires chapter/);
    await assert.rejects(engine.listCards({ scope: 'chapter', chapter: 'c1', deck: 'd2' }), /does not belong/);

    const byDeckField = await engine.listCards({ query: 'STM32', fields: ['deck_name'] });
    assert.deepEqual(byDeckField.cards.map((card) => card.id), ['k3']);
    const byIdField = await engine.listCards({ query: '^k2$', query_mode: 'regex', fields: ['id'] });
    assert.deepEqual(byIdField.cards.map((card) => card.id), ['k2']);

    const synced = await engine.listCards({ query_mode: 'predicate', predicate: { field: 'status', op: 'eq', value: 'synced' } });
    assert.equal(synced.total, 3);
    const any = await engine.listCards({
      predicate: { any: [{ field: 'id', op: 'eq', value: 'k1' }, { field: 'chapter_name', op: 'contains', value: 'SPI' }] },
    });
    assert.deepEqual(any.cards.map((card) => card.id), ['k1', 'k3']);
    const recentNotStm = await engine.listCards({
      predicate: {
        all: [
          { field: 'updated_time', op: 'gte', value: '2026-10-18' },
          { not: { field: 'deck_name', op: 'contains', value: 'STM32' } },
        ],
      },
    });
    assert.deepEqual(recentNotStm.cards.map((card) => card.id), ['k2']);
    const combined = await engine.listCards({ query: '变量', predicate: { field: 'deck_name', op: 'eq', value: 'c/c++' } });
    assert.deepEqual(combined.cards.map((card) => card.id), ['k1']);
    const regexPredicate = await engine.listCards({ predicate: { field: 'content', op: 'regex', value: 'SPI|指针' } });
    assert.deepEqual(regexPredicate.cards.map((card) => card.id), ['k2', 'k3']);

    await assert.rejects(engine.listCards({ predicate: { field: 'missing_field', op: 'eq', value: 1 } }), /unknown predicate field/);
    await assert.rejects(engine.listCards({ predicate: { field: 'id', op: 'nope', value: 1 } }), /predicate op/);
    await assert.rejects(engine.listCards({ query_mode: 'predicate', query: 'x' }), /query is not used/);
    await assert.rejects(engine.listCards({ query_mode: 'predicate' }), /predicate is required/);
    await assert.rejects(engine.listCards({ fields: ['nope'] }), /fields must be one of/);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('listDecks and listChapters apply their own filters', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-list-filter-'));
  const { store, engine } = await makeEngine(dir);
  try {
    const decks = await engine.listDecks({ query: 'stm32' });
    assert.deepEqual(decks.decks.map((deck) => deck.id), ['d2']);
    assert.equal(decks.total, 1);
    const fuzzyDeck = await engine.listDecks({ query: 'STM32', query_mode: 'fuzzy' });
    assert.equal(fuzzyDeck.decks[0].id, 'd2');
    assert.ok(fuzzyDeck.decks[0].score > 0);
    const bigDecks = await engine.listDecks({ predicate: { field: 'card_count', op: 'gte', value: 2 } });
    assert.deepEqual(bigDecks.decks.map((deck) => deck.id), ['d1']);
    await assert.rejects(engine.listDecks({ scope: 'folder' }), /requires folder_id/);
    await assert.rejects(engine.listDecks({ folder_id: 'missing' }), /Unknown folder/);

    const chapters = await engine.listChapters({ query: 'spi' });
    assert.equal(chapters.total, 1);
    assert.deepEqual(chapters.decks.map((deck) => deck.deck_id), ['d2']);
    assert.deepEqual(chapters.decks[0].chapters.map((chapter) => chapter.id), ['c2']);
    const largeChapter = await engine.listChapters({ predicate: { field: 'card_count', op: 'eq', value: 2 } });
    assert.equal(largeChapter.total, 1);
    assert.deepEqual(largeChapter.decks[0].chapters.map((chapter) => chapter.id), ['c1']);
    const byDeck = await engine.listChapters({ scope: 'deck', deck: 'd2' });
    assert.equal(byDeck.total, 1);
    assert.equal(byDeck.deck_id, 'd2');
    assert.deepEqual(byDeck.chapters.map((chapter) => chapter.id), ['c2']);
    await assert.rejects(engine.listChapters({ scope: 'all', deck: 'd2' }), /scope=all/);
    await assert.rejects(engine.listChapters({ scope: 'deck' }), /requires deck/);
    await assert.rejects(engine.listChapters({ scope: 'chapter', chapter: 'c1' }), /scope must be one of/);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('each list rejects fields owned by another resource', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-list-scope-'));
  const { store, engine } = await makeEngine(dir);
  try {
    // Decks: name / description / id and deck columns only.
    const byDescription = await engine.listDecks({ query: '内存' });
    assert.deepEqual(byDescription.decks.map((deck) => deck.id), ['d1']);
    const recentDeck = await engine.listDecks({ predicate: { field: 'updated_time', op: 'gte', value: '2026-05-02' } });
    assert.deepEqual(recentDeck.decks.map((deck) => deck.id), ['d2']);
    await assert.rejects(engine.listDecks({ fields: ['text'] }), /markji_decks: fields must be one of/);
    await assert.rejects(engine.listDecks({ predicate: { field: 'chapter_name', op: 'eq', value: 'SPI' } }), /unknown predicate field/);
    await assert.rejects(engine.listDecks({ predicate: { field: 'content', op: 'contains', value: 'SPI' } }), /unknown predicate field/);

    // Chapters: name / id text fields; chapter columns as predicates. There is
    // no description and no deck_name predicate (use scope=deck for that).
    const byName = await engine.listChapters({ query: '初始化', fields: ['name'] });
    assert.equal(byName.total, 1);
    assert.deepEqual(byName.decks[0].chapters.map((chapter) => chapter.id), ['c1']);
    const byOrder = await engine.listChapters({ predicate: { field: 'order', op: 'gte', value: 2 } });
    assert.equal(byOrder.total, 1);
    assert.deepEqual(byOrder.decks[0].chapters.map((chapter) => chapter.id), ['c2']);
    const byUpdated = await engine.listChapters({ predicate: { field: 'updated_time', op: 'gte', value: '2026-04-02' } });
    assert.deepEqual(byUpdated.decks[0].chapters.map((chapter) => chapter.id), ['c2']);
    await assert.rejects(engine.listChapters({ fields: ['description'] }), /markji_chapters: fields must be one of: name, id/);
    await assert.rejects(engine.listChapters({ fields: ['deck_name'] }), /markji_chapters: fields must be one of/);
    await assert.rejects(engine.listChapters({ predicate: { field: 'description', op: 'eq', value: 'x' } }), /unknown predicate field/);
    await assert.rejects(engine.listChapters({ predicate: { field: 'deck_name', op: 'eq', value: 'STM32 协议' } }), /unknown predicate field/);

    // Cards retain the wider card-only fields.
    await assert.rejects(engine.listCards({ fields: ['description'] }), /markji_cards: fields must be one of/);
    const byContent = await engine.listCards({ predicate: { field: 'content', op: 'contains', value: 'SPI' } });
    assert.deepEqual(byContent.cards.map((card) => card.id), ['k3']);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
