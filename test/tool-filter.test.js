import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../lib/tools.js';

test('markji_cards action=list forwards only the filter tree', async () => {
  const registered = new Map();
  let payload = null;
  const engine = {
    async ready() {},
    async listCards(args) {
      payload = args;
      return { total: 0, cards: [] };
    },
  };
  const ctx = {
    tools: {
      register(spec) {
        registered.set(spec.name, spec);
        return () => {};
      },
    },
    get() {
      return undefined;
    },
  };
  const dispose = registerTools(ctx, { engine, config: { maxOutputChars: 20000 }, log: () => {} });
  try {
    const tool = registered.get('markji_cards');
    assert.ok(tool);
    assert.equal(tool.parameters.properties.filter.type, 'object');
    for (const removed of ['query', 'query_mode', 'predicate', 'fields', 'regex_flags', 'min_score']) {
      assert.equal(tool.parameters.properties[removed], undefined, removed);
    }

    const filter = { field: 'status', op: 'eq', value: 'synced' };
    await tool.execute(
      { action: 'list', scope: 'deck', deck: 'd1', filter },
      { agent: { id: 'session' }, callId: 'call' },
    );
    assert.deepEqual(payload, { scope: 'deck', deck: 'd1', filter });

    const second = { any: [{ field: 'id', op: 'eq', value: 'k1' }, { field: 'text', op: 'contains', value: 'spi' }] };
    await tool.execute(
      { action: 'list', filter: second },
      { agent: { id: 'session' }, callId: 'call' },
    );
    assert.deepEqual(payload, { filter: second });

    await assert.rejects(
      tool.execute({ action: 'search', filter }, { agent: { id: 'session' } }),
      /action.*must be one of/,
    );
    await assert.rejects(
      tool.execute({ action: 'list', query: 'spi' }, { agent: { id: 'session' } }),
      /"query" is no longer supported/,
    );
    await assert.rejects(
      tool.execute({ action: 'list', query_mode: 'fuzzy' }, { agent: { id: 'session' } }),
      /"query_mode" is no longer supported/,
    );
    await assert.rejects(
      tool.execute({ action: 'list', filter: 'spi' }, { agent: { id: 'session' } }),
      /filter.*must be an object/,
    );
  } finally {
    dispose();
  }
});

test('markji_decks list and chapter_list forward filters', async () => {
  const registered = new Map();
  const calls = [];
  const engine = {
    async ready() {},
    async listDecks(args) {
      calls.push(['listDecks', args]);
      return { folders: [], decks: [], total: 0 };
    },
    async listChapters(args) {
      calls.push(['listChapters', args]);
      return { decks: [], total: 0 };
    },
  };
  const ctx = { tools: { register(spec) { registered.set(spec.name, spec); return () => {}; } }, get() { return undefined; } };
  const dispose = registerTools(ctx, { engine, config: { maxOutputChars: 20000 }, log: () => {} });
  try {
    const tool = registered.get('markji_decks');
    const deckFilter = { field: 'card_count', op: 'gte', value: 2 };
    await tool.execute(
      { action: 'list', scope: 'folder', folder_id: 'f1', filter: deckFilter },
      { agent: { id: 'session' } },
    );
    assert.deepEqual(calls[0], ['listDecks', {
      folder_id: 'f1',
      scope: 'folder',
      filter: deckFilter,
      refresh: false,
    }]);

    const chapterFilter = { field: 'name', op: 'regex', value: 'spi' };
    await tool.execute(
      { action: 'chapter_list', scope: 'deck', deck: 'd1', filter: chapterFilter },
      { agent: { id: 'session' } },
    );
    assert.deepEqual(calls[1], ['listChapters', {
      deck: 'd1',
      scope: 'deck',
      filter: chapterFilter,
      refresh: false,
    }]);
  } finally {
    dispose();
  }
});
