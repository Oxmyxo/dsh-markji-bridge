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

test('search supports fuzzy, regex and query flags', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-search-modes-'));
  const { store, engine } = await makeEngine(dir);
  try {
    const fuzzy = await engine.searchCards({ query: '变量初始话', query_mode: 'fuzzy' });
    assert.equal(fuzzy.total, 1);
    assert.equal(fuzzy.cards[0].id, 'k1');
    assert.equal(fuzzy.cards[0].matched_by, 'text');
    assert.ok(fuzzy.cards[0].score >= 0.6 && fuzzy.cards[0].score <= 1, JSON.stringify(fuzzy.cards[0]));
    assert.match(fuzzy.cards[0].snippet, /变量/);
    assert.equal(fuzzy.filters.query_mode, 'fuzzy');
    assert.equal(fuzzy.filters.min_score, 0.6);
    assert.equal(fuzzy.filters.regex_flags, null);

    const strictFuzzy = await engine.searchCards({ query: '变量初始话', query_mode: 'fuzzy', min_score: 0.9 });
    assert.equal(strictFuzzy.total, 0);

    const multiTerm = await engine.searchCards({ query: '变量 初始化', query_mode: 'fuzzy' });
    assert.deepEqual(multiTerm.cards.map((card) => card.id), ['k1']);
    const noisy = await engine.searchCards({ query: '变量 指针', query_mode: 'fuzzy' });
    assert.equal(noisy.total, 0);
    const partial = await engine.searchCards({ query: '变量 初始化 指针', query_mode: 'fuzzy' });
    assert.equal(partial.partial, true);
    assert.equal(partial.cards[0].id, 'k1');
    assert.deepEqual(partial.cards[0].matched_terms, ['变量', '初始化']);
    assert.equal(partial.fallback_terms.length, 3);
    assert.ok(partial.cards[0].score > 0);
    assert.match(partial.hint, /partial matches/);
    const missing = await engine.searchCards({ query: '变量 指针 时钟', query_mode: 'fuzzy' });
    assert.equal(missing.partial, true);
    assert.equal(missing.total, 3);
    assert.equal(missing.fallback_terms.length, 3);
    assert.ok(missing.cards.every((card) => Array.isArray(card.matched_terms) && card.matched_terms.length === 1));
    assert.match(missing.hint, /partial matches/);
    const missingList = await engine.listCards({ query: '变量 指针 时钟', query_mode: 'fuzzy' });
    assert.equal(missingList.partial, true);
    assert.equal(missingList.total, 3);
    assert.match(missingList.hint, /partial matches/);

    const regex = await engine.searchCards({ query: '变量|指针', query_mode: 'regex' });
    assert.deepEqual(regex.cards.map((card) => card.id), ['k1', 'k2']);
    assert.equal(regex.filters.query_mode, 'regex');
    assert.equal(regex.filters.regex_flags, 'i');
    assert.equal(regex.filters.min_score, null);

    const insensitive = await engine.searchCards({ query: 'spi', query_mode: 'regex' });
    assert.deepEqual(insensitive.cards.map((card) => card.id), ['k3']);
    const sensitive = await engine.searchCards({ query: 'spi', query_mode: 'regex', regex_flags: 'm' });
    assert.equal(sensitive.total, 0);

    const byId = await engine.searchCards({ query: '^k[12]$', query_mode: 'regex' });
    assert.deepEqual(byId.cards.map((card) => card.id), ['k1', 'k2']);
    assert.equal(byId.cards[0].matched_by, 'id');

    const listed = await engine.listCards({ query: '变量初始话', query_mode: 'fuzzy' });
    assert.equal(listed.total, 1);
    assert.equal(listed.cards[0].id, 'k1');
    assert.equal(listed.cards[0].matched_by, 'text');

    await assert.rejects(engine.searchCards({ query: '[', query_mode: 'regex' }), /valid regular expression/);
    await assert.rejects(engine.searchCards({ query: 'spi', query_mode: 'regex', regex_flags: 'g' }), /regex_flags/);
    await assert.rejects(engine.searchCards({ query: 'spi', query_mode: 'fuzzy', min_score: 2 }), /min_score/);
    await assert.rejects(engine.searchCards({ query: 'spi', query_mode: 'wildcard' }), /query_mode/);
  } finally {
    await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
