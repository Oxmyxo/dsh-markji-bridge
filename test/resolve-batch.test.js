/**
 * Bulk conflict resolution: single-id regression, ids/items batch forms,
 * per-item isolation, limits and the tool surface.
 *
 * Run: node --test "test/resolve-batch.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockMarkji } from './mock-server.mjs';
import { createClient } from '../lib/api.js';
import { createLimiter } from '../lib/rate-limit.js';
import { createStore } from '../lib/store.js';
import { createEngine } from '../lib/sync.js';
import { registerTools } from '../lib/tools.js';

function makeConfig(mock) {
  return {
    apiKey: mock.token,
    baseUrl: mock.url,
    requestTimeoutMs: 5000,
    maxRetries: 1,
    pageSize: 100,
    grammarVersion: 3,
    pullTtlMs: 600000,
    autoSync: false,
    idleCheckMs: 60000,
    idleQuietMs: 10000,
    autoPullMs: 900000,
    retryBackoffMs: 300000,
    maxOutputChars: 20000,
  };
}

async function withFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'markji-resolve-'));
  const mock = await startMockMarkji({ token: 'resolve-token' });
  let engine = null;
  let store = null;
  try {
    const deck = mock.newDeck('冲突测试', { chapters: ['普通'] });
    const chapter = mock.state.chapters[0];
    const cards = [];
    for (let index = 0; index < 5; index += 1) cards.push(mock.newCard(deck.id, chapter.id, '原始内容 ' + index));
    const config = makeConfig(mock);
    const limiter = createLimiter({ limits: [{ windowMs: 1000, max: 1000 }], now: Date.now });
    const client = createClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      limiter,
      log: () => {},
    });
    store = createStore({ dataDir: dir, log: () => {}, clock: Date.now });
    engine = createEngine({ client, store, config, log: () => {}, clock: Date.now });
    await engine.ready();
    await engine.sync({ mode: 'pull', full: true });
    const registered = new Map();
    const dispose = registerTools(
      {
        tools: {
          register(definition) {
            registered.set(definition.name, definition);
            return () => {};
          },
        },
      },
      { engine, config, log: () => {}, client },
    );
    try {
      await run({
        call: (name, args) => registered.get(name).execute(args),
        registered,
        engine,
        mock,
        deck,
        chapter,
        cards,
      });
    } finally {
      dispose();
    }
  } finally {
    if (engine) await engine.stop();
    if (store) await store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

/** Queue a local edit, change the same card in the Markji app, then pull. */
async function makeCardConflict(engine, mock, card, tag) {
  await engine.updateCard({ card: card.id, content: '本地编辑 ' + tag });
  mock.remoteEditCard(card.id, '云端内容 ' + tag);
  await engine.pull({ full: false });
  const report = await engine.failures();
  const conflict = report.conflicts.find((entry) => entry.card_id === card.id && entry.kind === 'card-both-modified');
  assert.ok(conflict, 'expected a card-both-modified conflict for ' + card.id + ': ' + JSON.stringify(report.conflicts));
  return conflict;
}

function pendingContent(engine, cardId) {
  const card = engine._internal.orderedCards().find((entry) => entry.id === cardId);
  assert.ok(card, 'card ' + cardId + ' is still cached');
  return card.pending === null || card.pending === undefined ? null : card.pending.content;
}

test('single-id resolve keeps the original return shape and clears the conflict', async () => {
  await withFixture(async ({ engine, mock, cards }) => {
    const conflict = await makeCardConflict(engine, mock, cards[0], 'single');
    const result = await engine.resolveConflict({ id: conflict.id, strategy: 'keep_remote' });
    assert.deepEqual(result, {
      ok: true,
      id: conflict.id,
      entity: 'card',
      strategy: 'keep_remote',
      state: 'resolved',
      changed: true,
    });
    assert.equal(pendingContent(engine, cards[0].id), null);
    assert.equal((await engine.failures()).summary.conflicts, 0);
  });
});

test('ids batch resolves every conflict, reports per-item results and pushes cleanly', async () => {
  await withFixture(async ({ engine, mock, cards }) => {
    const conflicts = [];
    for (let index = 0; index < 3; index += 1) {
      conflicts.push(await makeCardConflict(engine, mock, cards[index], 'ids-' + index));
    }
    const ids = conflicts.map((entry) => entry.id);
    const result = await engine.resolveConflict({ ids, strategy: 'keep_local' });
    assert.equal(result.ok, true);
    assert.equal(result.total, 3);
    assert.equal(result.resolved, 3);
    assert.equal(result.failed, 0);
    assert.equal(result.results.length, 3);
    for (let index = 0; index < 3; index += 1) {
      assert.deepEqual(result.results[index], {
        id: ids[index],
        ok: true,
        changed: true,
        state: 'resolved',
        strategy: 'keep_local',
      });
    }
    assert.equal((await engine.failures()).summary.conflicts, 0);

    const report = await engine.push();
    assert.deepEqual(report.errors, []);
    for (let index = 0; index < 3; index += 1) {
      assert.equal(engine._internal.orderedCards().find((entry) => entry.id === cards[index].id).content, '本地编辑 ids-' + index);
    }
    const remote = [0, 1, 2].map((index) => mock.state.cards.find((card) => card.id === cards[index].id).content);
    assert.deepEqual(remote, ['本地编辑 ids-0', '本地编辑 ids-1', '本地编辑 ids-2']);
    assert.equal((await engine.failures()).summary.conflicts, 0);
  });
});

test('a partially failed ids batch still resolves the rest and counts failures', async () => {
  await withFixture(async ({ engine, mock, cards }) => {
    const first = await makeCardConflict(engine, mock, cards[0], 'partial-0');
    const second = await makeCardConflict(engine, mock, cards[1], 'partial-1');
    await engine.resolveConflict({ id: first.id, strategy: 'keep_remote' });
    const result = await engine.resolveConflict({
      ids: [first.id, second.id, 'cf_missing'],
      strategy: 'keep_remote',
    });
    assert.equal(result.ok, false);
    assert.equal(result.total, 3);
    assert.equal(result.resolved, 1);
    assert.equal(result.failed, 2);
    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[0].error.code, 'unknown_conflict');
    assert.equal(result.results[1].ok, true);
    assert.equal(result.results[1].id, second.id);
    assert.equal(result.results[2].ok, false);
    assert.equal(result.results[2].error.code, 'unknown_conflict');
    assert.equal((await engine.failures()).summary.conflicts, 0);
    assert.equal(pendingContent(engine, cards[1].id), null);
  });
});

test('items allow mixed strategies and isolate a bad item', async () => {
  await withFixture(async ({ engine, mock, cards }) => {
    const local = await makeCardConflict(engine, mock, cards[0], 'mixed-0');
    const remote = await makeCardConflict(engine, mock, cards[1], 'mixed-1');
    const replace = await makeCardConflict(engine, mock, cards[2], 'mixed-2');
    const result = await engine.resolveConflict({
      items: [
        { id: local.id, strategy: 'keep_local' },
        { id: 'cf_missing', strategy: 'keep_local' },
        { id: remote.id, strategy: 'keep_remote' },
        { id: replace.id, strategy: 'use_content', content: '统一替换内容' },
        { id: cards[3].id, strategy: 'bogus' },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.total, 5);
    assert.equal(result.resolved, 3);
    assert.equal(result.failed, 2);
    assert.equal(result.results[0].strategy, 'keep_local');
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[1].error.code, 'unknown_conflict');
    assert.equal(result.results[2].ok, true);
    assert.equal(result.results[2].strategy, 'keep_remote');
    assert.equal(result.results[3].ok, true);
    assert.equal(result.results[3].strategy, 'use_content');
    assert.equal(result.results[4].ok, false);
    assert.equal(result.results[4].error.code, 'invalid_argument', 'a bad item strategy is a per-item failure');
    assert.equal(pendingContent(engine, cards[0].id), '本地编辑 mixed-0');
    assert.equal(pendingContent(engine, cards[1].id), null);
    assert.equal(pendingContent(engine, cards[2].id), '统一替换内容');
  });
});

test('ids with use_content applies the same replacement to every id', async () => {
  await withFixture(async ({ engine, mock, cards }) => {
    const first = await makeCardConflict(engine, mock, cards[0], 'shared-0');
    const second = await makeCardConflict(engine, mock, cards[1], 'shared-1');
    const result = await engine.resolveConflict({
      ids: [first.id, second.id],
      strategy: 'use_content',
      content: '共享替换 [E##x+y]',
    });
    assert.equal(result.ok, true);
    assert.equal(result.resolved, 2);
    assert.equal(pendingContent(engine, cards[0].id), '共享替换 [E##x+y]');
    assert.equal(pendingContent(engine, cards[1].id), '共享替换 [E##x+y]');
  });
});

test('duplicate ids and duplicate items are collapsed before resolving', async () => {
  await withFixture(async ({ engine, mock, cards }) => {
    const conflict = await makeCardConflict(engine, mock, cards[0], 'dedupe');
    const byIds = await engine.resolveConflict({ ids: [conflict.id, conflict.id], strategy: 'keep_remote' });
    assert.equal(byIds.total, 1);
    assert.equal(byIds.resolved, 1);

    const again = await makeCardConflict(engine, mock, cards[1], 'dedupe-items');
    const byItems = await engine.resolveConflict({
      items: [
        { id: again.id, strategy: 'keep_local' },
        { id: again.id, strategy: 'keep_remote' },
      ],
    });
    assert.equal(byItems.total, 1, 'the first duplicate wins');
    assert.equal(byItems.results[0].strategy, 'keep_local');
    assert.equal(pendingContent(engine, cards[1].id), '本地编辑 dedupe-items');
  });
});

test('fatal argument errors reject the whole call', async () => {
  await withFixture(async ({ engine }) => {
    const fiftyOne = Array.from({ length: 51 }, (_, index) => 'cf_' + (index + 1));
    await assert.rejects(engine.resolveConflict({ ids: fiftyOne, strategy: 'keep_local' }), (error) => {
      assert.equal(error.code, 'invalid_argument');
      assert.match(error.message, /at most 50/);
      return true;
    });
    await assert.rejects(
      engine.resolveConflict({ ids: fiftyOne, items: [{ id: 'cf_1', strategy: 'keep_local' }] }),
      (error) => {
        assert.equal(error.code, 'invalid_argument');
        assert.match(error.message, /either ids or items/);
        return true;
      },
    );
    await assert.rejects(
      engine.resolveConflict({ id: 'cf_1', strategy: 'keep_local', ids: ['cf_1'] }),
      (error) => {
        assert.equal(error.code, 'invalid_argument');
        assert.match(error.message, /either id or ids/);
        return true;
      },
    );
    await assert.rejects(
      engine.resolveConflict({ items: Array.from({ length: 51 }, (_, index) => ({ id: 'cf_' + (index + 1), strategy: 'keep_local' })) }),
      (error) => {
        assert.equal(error.code, 'invalid_argument');
        assert.match(error.message, /at most 50/);
        return true;
      },
    );
    await assert.rejects(engine.resolveConflict({ ids: ['cf_1'], strategy: 'use_content' }), (error) => {
      assert.equal(error.code, 'invalid_content');
      return true;
    });
    await assert.rejects(engine.resolveConflict({ ids: ['cf_1'], strategy: 'keep_local', content: '不该出现' }), (error) => {
      assert.equal(error.code, 'invalid_argument');
      assert.match(error.message, /content is only supported/);
      return true;
    });
    await assert.rejects(engine.resolveConflict({ items: ['cf_1'] }), (error) => {
      assert.equal(error.code, 'invalid_argument');
      assert.match(error.message, /items\[0\]/);
      return true;
    });
  });
});

test('failures exposes single and batch recovery arguments', async () => {
  await withFixture(async ({ engine, mock, cards }) => {
    const conflict = await makeCardConflict(engine, mock, cards[0], 'recovery');
    const report = await engine.failures();
    const view = report.conflicts.find((entry) => entry.id === conflict.id);
    assert.ok(view);
    assert.deepEqual(view.recovery.arguments, { action: 'resolve', id: conflict.id, strategy: 'keep_local' });
    assert.deepEqual(view.recovery.batch_arguments, { action: 'resolve', ids: [conflict.id], strategy: 'keep_local' });
    assert.match(view.recovery.hint, /ids/);
    assert.deepEqual(report.batch_arguments, { action: 'resolve', ids: [conflict.id], strategy: 'keep_remote' });

    const next = await makeCardConflict(engine, mock, cards[1], 'recovery-batch');
    const latest = await engine.failures();
    assert.deepEqual(latest.batch_arguments, {
      action: 'resolve',
      ids: [conflict.id, next.id],
      strategy: 'keep_remote',
    });
    // The top-level batch_arguments can be fed straight back into the tool.
    const result = await engine.resolveConflict(latest.batch_arguments);
    assert.equal(result.ok, true);
    assert.equal(result.resolved, 2);
    assert.equal((await engine.failures()).summary.conflicts, 0);
    assert.equal((await engine.failures()).batch_arguments, null, 'nothing left to batch-resolve');
  });
});

test('the markji_sync action=resolve tool accepts ids/items and returns partial results', async () => {
  await withFixture(async ({ call, registered, engine, mock, cards }) => {
    const def = registered.get('markji_sync');
    assert.ok(def.parameters.properties.ids, 'markji_sync exposes ids');
    assert.ok(def.parameters.properties.items, 'markji_sync exposes items');
    assert.equal(
      def.parameters.properties.items.items.properties.strategy.type,
      'string',
      'a per-item strategy is validated by the engine so one bad item does not abort the batch',
    );

    const single = await makeCardConflict(engine, mock, cards[0], 'tool-single');
    const resolved = await call('markji_sync', { action: 'resolve', id: single.id, strategy: 'keep_remote' });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.id, single.id);
    assert.equal(resolved.state, 'resolved');

    const first = await makeCardConflict(engine, mock, cards[1], 'tool-batch-0');
    const second = await makeCardConflict(engine, mock, cards[2], 'tool-batch-1');
    const batch = await call('markji_sync', {
      action: 'resolve',
      items: [
        { id: first.id, strategy: 'keep_local' },
        { id: second.id, strategy: 'keep_remote' },
        { id: 'cf_missing', strategy: 'keep_local' },
        { id: 'cf_whatever', strategy: 'bogus' },
      ],
    });
    assert.equal(batch.ok, false, 'a partial batch is data, not a tool error');
    assert.equal(batch.total, 4);
    assert.equal(batch.resolved, 2);
    assert.equal(batch.failed, 2);
    assert.equal(batch.results[2].error.code, 'unknown_conflict');
    assert.equal(batch.results[3].error.code, 'invalid_argument', 'a bad per-item strategy fails only that item');

    const shared = await makeCardConflict(engine, mock, cards[3], 'tool-use-content');
    const replaced = await call('markji_sync', {
      action: 'resolve',
      ids: [shared.id],
      strategy: 'use_content',
      content: '工具替换内容',
    });
    assert.equal(replaced.ok, true);
    assert.equal(pendingContent(engine, cards[3].id), '工具替换内容');
  });
});
