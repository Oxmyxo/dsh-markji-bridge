import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../lib/tools.js';

test('markji_cards action=list forwards query, predicate and scope filters', async () => {
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
    await tool.execute(
      {
        action: 'list',
        scope: 'deck',
        deck: 'd1',
        query: '变量初始话',
        query_mode: 'fuzzy',
        min_score: 0.7,
        fields: ['text', 'id'],
        predicate: { field: 'status', op: 'eq', value: 'synced' },
      },
      { agent: { id: 'session' }, callId: 'call' },
    );
    assert.deepEqual(payload, {
      scope: 'deck',
      deck: 'd1',
      query: '变量初始话',
      query_mode: 'fuzzy',
      min_score: 0.7,
      fields: ['text', 'id'],
      predicate: { field: 'status', op: 'eq', value: 'synced' },
    });

    await tool.execute(
      { action: 'list', query: 'spi', query_mode: 'regex', regex_flags: 'im' },
      { agent: { id: 'session' }, callId: 'call' },
    );
    assert.deepEqual(payload, {
      query: 'spi',
      query_mode: 'regex',
      regex_flags: 'im',
    });

    await assert.rejects(
      tool.execute({ action: 'search', query: 'spi' }, { agent: { id: 'session' } }),
      /action.*must be one of/,
    );
    await assert.rejects(
      tool.execute({ action: 'list', query: 'spi', query_mode: 'wildcard' }, { agent: { id: 'session' } }),
      /query_mode/,
    );
    await assert.rejects(
      tool.execute({ action: 'list', query: 'spi', query_mode: 'fuzzy', min_score: 2 }, { agent: { id: 'session' } }),
      /min_score/,
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
    await tool.execute(
      { action: 'list', scope: 'folder', folder_id: 'f1', query: 'c++', query_mode: 'predicate', predicate: { field: 'card_count', op: 'gte', value: 2 }, fields: ['name'] },
      { agent: { id: 'session' } },
    );
    assert.deepEqual(calls[0], ['listDecks', {
      folder_id: 'f1',
      scope: 'folder',
      query: 'c++',
      query_mode: 'predicate',
      predicate: { field: 'card_count', op: 'gte', value: 2 },
      fields: ['name'],
      refresh: false,
    }]);
    await tool.execute(
      { action: 'chapter_list', scope: 'deck', deck: 'd1', query: 'spi', query_mode: 'regex', regex_flags: 'i' },
      { agent: { id: 'session' } },
    );
    assert.deepEqual(calls[1], ['listChapters', {
      deck: 'd1',
      scope: 'deck',
      query: 'spi',
      query_mode: 'regex',
      regex_flags: 'i',
      refresh: false,
    }]);
  } finally {
    dispose();
  }
});
