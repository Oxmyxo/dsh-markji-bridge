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
      d1: { id: 'd1', name: 'C/C++', chapter_ids: ['c1'], card_count: 2 },
      d2: { id: 'd2', name: 'STM32 协议', chapter_ids: ['c2'], card_count: 1 },
    },
    chapters: {
      c1: { id: 'c1', deck_id: 'd1', name: '初始化', card_ids: ['k1', 'k2'] },
      c2: { id: 'c2', deck_id: 'd2', name: 'SPI', card_ids: ['k3'] },
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

test('markji_search filters by deck name, chapter name, content and updated time', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-search-'));
  const { store, engine } = await makeEngine(dir);
  try {
    const all = await engine.searchCards({});
    assert.equal(all.total, 3);
    assert.deepEqual(all.cards.map((card) => card.id), ['k1', 'k2', 'k3']);
    assert.equal(all.cards[0].deck_name, 'C/C++');
    assert.equal(all.cards[0].chapter_name, '初始化');

    const byDeck = await engine.searchCards({ deck_name: 'c/c' });
    assert.deepEqual(byDeck.cards.map((card) => card.id), ['k1', 'k2']);

    const byChapter = await engine.searchCards({ chapter_name: 'spi' });
    assert.deepEqual(byChapter.cards.map((card) => card.id), ['k3']);

    const byContent = await engine.searchCards({ query: '变量' });
    assert.equal(byContent.total, 1);
    assert.equal(byContent.cards[0].id, 'k1');
    assert.match(byContent.cards[0].snippet, /变量/);

    const byTime = await engine.searchCards({ updated_after: '2026-10-01' });
    assert.deepEqual(byTime.cards.map((card) => card.id), ['k2', 'k3']);
    const range = await engine.searchCards({ updated_after: '2026-10-18T00:00:00Z', updated_before: '2026-10-18T23:59:59Z' });
    assert.deepEqual(range.cards.map((card) => card.id), ['k2']);

    const paged = await engine.searchCards({ limit: 1, offset: 1 });
    assert.equal(paged.total, 3);
    assert.equal(paged.has_more, true);
    assert.equal(paged.cards[0].id, 'k2');

    await assert.rejects(engine.searchCards({ updated_after: 'not-a-time' }), /not a valid ISO 8601/);
    await assert.rejects(engine.searchCards({ deck: 'missing' }), /unknown_deck|Unknown deck/);
    await assert.rejects(engine.searchCards({ updated_after: '2026-10-19', updated_before: '2026-10-18' }), /must not be later/);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
