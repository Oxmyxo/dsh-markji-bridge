import test from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../lib/tools.js';

test('markji_cards action=search forwards fuzzy and regex options', async () => {
  const registered = new Map();
  let payload = null;
  const engine = {
    async ready() {},
    async searchCards(args) {
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
      { action: 'search', query: '变量初始话', query_mode: 'fuzzy', min_score: 0.7 },
      { agent: { id: 'session' }, callId: 'call' },
    );
    assert.deepEqual(payload, {
      query: '变量初始话',
      query_mode: 'fuzzy',
      min_score: 0.7,
      refresh: false,
    });

    await tool.execute(
      { action: 'search', query: 'spi', query_mode: 'regex', regex_flags: 'im' },
      { agent: { id: 'session' }, callId: 'call' },
    );
    assert.deepEqual(payload, {
      query: 'spi',
      query_mode: 'regex',
      regex_flags: 'im',
      refresh: false,
    });

    await assert.rejects(
      tool.execute({ action: 'search', query: 'spi', query_mode: 'wildcard' }, { agent: { id: 'session' } }),
      /query_mode/,
    );
    await assert.rejects(
      tool.execute({ action: 'search', query: 'spi', query_mode: 'fuzzy', min_score: 2 }, { agent: { id: 'session' } }),
      /min_score/,
    );
  } finally {
    dispose();
  }
});
