// Explicit refresh must not disguise a failed provider read as cached success.
// Isolated client + memory store only: no fetch/socket, real cache, or credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEngine } from '../lib/sync.js';
import { MarkjiError } from '../lib/api.js';

const NOW = 1700000100000;
const calls = [
  ['listDecks', {}],
  ['listChapters', { deck: 'd1' }],
  ['getDeck', { deck: 'd1' }],
  ['getChapter', { deck: 'd1', chapter: 'ch1', with_cards: true }],
  ['listCards', { deck: 'd1' }],
  ['getCard', { card: 'k1' }],
  ['getCards', { cards: ['k1'] }],
];

function fixture({ fresh = false, fail = true, configured = true } = {}) {
  const cache = {
    meta: { last_pull_at: fresh ? NOW : 0 },
    folders: {},
    decks: { d1: { id: 'd1', name: 'CACHED-DECK-MARKER', card_count: 1, chapter_count: 1, chapterset_revision: 1, chapter_ids: ['ch1'] } },
    chapters: { ch1: { id: 'ch1', deck_id: 'd1', name: 'CACHED-CHAPTER-MARKER', card_ids: ['k1'], order: 0 } },
    cards: { k1: { id: 'k1', deck_id: 'd1', chapter_id: 'ch1', content: 'CACHED-CARD-MARKER', grammar_version: 3, cloud: { revision: 1 } } },
    conflicts: [], moves: [], tasks: {},
  };
  const error = new MarkjiError({ code: 'common_internal_error', status: 503, message: 'Provider unavailable', retriable: true });
  error.request = { method: 'GET', path: '/markji/decks/folders' };
  const reads = [];
  const client = {
    configured,
    listFolders: async () => {
      reads.push('listFolders');
      if (fail) throw error;
      return [];
    },
    listAllDecks: async () => { reads.push('listAllDecks'); return []; },
  };
  const store = {
    cache,
    load: async () => cache,
    refreshIfChanged: async () => {},
    withWriteLock: async (operation) => operation(),
    markDirty: () => {},
    saveNow: async () => {},
  };
  const engine = createEngine({ client, store, clock: () => NOW, config: { autoSync: false, pullTtlMs: 1000 } });
  return { engine, cache, reads, error };
}

for (const [method, args] of calls) {
  // Single/batch card get have no public refresh option; preserve that surface.
  if (method !== 'getCard' && method !== 'getCards') test(`${method}: refresh=true rejects original provider error instead of returning old cache`, async () => {
    const f = fixture({ fresh: true });
    const before = JSON.stringify({ decks: f.cache.decks, chapters: f.cache.chapters, cards: f.cache.cards });
    try {
      await assert.rejects(f.engine[method]({ ...args, refresh: true }), (error) => {
        assert.equal(error, f.error, 'preserve provider error identity and diagnostics');
        assert.equal(error.status, 503);
        assert.deepEqual(error.request, { method: 'GET', path: '/markji/decks/folders' });
        return true;
      });
      assert.deepEqual(f.reads, ['listFolders'], 'one refresh attempt, no forcePullForMissing replay');
      assert.equal(JSON.stringify({ decks: f.cache.decks, chapters: f.cache.chapters, cards: f.cache.cards }), before);
    } finally { await f.engine.stop(); }
  });

  test(`${method}: default stale read retains cache fallback after provider error`, async () => {
    const f = fixture();
    try {
      const result = await f.engine[method](args);
      assert.match(JSON.stringify(result), /CACHED-(DECK|CHAPTER|CARD)-MARKER/);
      assert.deepEqual(f.reads, ['listFolders']);
    } finally { await f.engine.stop(); }
  });

  test(`${method}: default fresh cache performs no provider request`, async () => {
    const f = fixture({ fresh: true });
    try {
      const result = await f.engine[method](args);
      assert.match(JSON.stringify(result), /CACHED-(DECK|CHAPTER|CARD)-MARKER/);
      assert.deepEqual(f.reads, []);
    } finally { await f.engine.stop(); }
  });
}

test('ensureFresh requireFresh=true preserves provider failure and never returns cache success', async () => {
  const f = fixture({ fresh: true });
  try {
    await assert.rejects(f.engine.ensureFresh(0, true), (error) => error === f.error);
    assert.deepEqual(f.reads, ['listFolders']);
  } finally { await f.engine.stop(); }
});

test('not configured: explicit refresh fails while default cache read remains usable', async () => {
  const f = fixture({ configured: false });
  try {
    await assert.rejects(f.engine.listDecks({ refresh: true }), (error) => error.code === 'not_configured');
    await assert.rejects(f.engine.ensureFresh(0, true), (error) => error.code === 'not_configured');
    assert.match(JSON.stringify(await f.engine.listDecks()), /CACHED-DECK-MARKER/);
    assert.deepEqual(f.reads, [], 'no provider request without configured credentials');
  } finally { await f.engine.stop(); }
});

test('explicit list refresh propagates failure even with an empty cache', async () => {
  const f = fixture();
  f.cache.decks = {};
  f.cache.chapters = {};
  f.cache.cards = {};
  try {
    await assert.rejects(f.engine.listDecks({ refresh: true }), (error) => error === f.error);
    assert.deepEqual(f.reads, ['listFolders']);
  } finally { await f.engine.stop(); }
});

test('explicit list refresh can return a legitimately empty successful pull', async () => {
  const f = fixture({ fail: false });
  f.cache.decks = {};
  f.cache.chapters = {};
  f.cache.cards = {};
  try {
    const result = await f.engine.listDecks({ refresh: true });
    assert.equal(result.total, 0);
    assert.deepEqual(result.decks, []);
    assert.deepEqual(f.reads, ['listFolders', 'listAllDecks']);
  } finally { await f.engine.stop(); }
});
