/**
 * Archive + failure-report tests (offline, mock provider).
 *
 * Run: node --test "test/archive.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockMarkji } from './mock-server.mjs';
import { createClient, MarkjiError } from '../lib/api.js';
import { createLimiter } from '../lib/rate-limit.js';
import { createStore } from '../lib/store.js';
import { createEngine } from '../lib/sync.js';

function makeEngine(dir, mock, clientOverride) {
  const config = {
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
  const limiter = createLimiter({ limits: [{ windowMs: 1000, max: 1000 }], now: Date.now });
  const baseClient = createClient({
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    timeoutMs: config.requestTimeoutMs,
    maxRetries: config.maxRetries,
    limiter,
    log: () => {},
  });
  const client = clientOverride ? clientOverride(baseClient) : baseClient;
  const store = createStore({ dataDir: dir, log: () => {}, clock: Date.now });
  const engine = createEngine({ client, store, config, log: () => {}, clock: Date.now });
  return { engine, store, client };
}

async function withFixture(name, run) {
  const dir = await mkdtemp(join(tmpdir(), 'markji-archive-'));
  const mock = await startMockMarkji({ token: 'archive-token' });
  let engine = null;
  let store = null;
  try {
    const deck = mock.newDeck(name, { chapters: ['普通'] });
    const chapter = mock.state.chapters[0];
    const card = mock.newCard(deck.id, chapter.id, '原始内容');
    ({ engine, store } = makeEngine(dir, mock));
    await engine.ready();
    await engine.sync({ mode: 'pull', full: true });
    await run({ engine, store, mock, deck, chapter, card, dir });
  } finally {
    if (engine) await engine.stop();
    if (store) await store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test('archive moves a card into the deck archive chapter and prepends the notice', async () => {
  await withFixture('归档测试', async ({ engine, mock, deck, card }) => {
    const result = await engine.archiveCards({ cards: [card.id] });
    assert.equal(result.ok, true);
    assert.equal(result.archived, 1);
    assert.equal(result.content_updated, 1);
    assert.equal(result.chapters.length, 1);
    assert.equal(result.chapters[0].chapter_name, '归档');
    assert.equal(result.chapters[0].deck_id, deck.id);
    assert.equal(result.chapters[0].local, true);

    const local = engine._internal.orderedCards().find((entry) => entry.id === card.id);
    assert.ok(local.content.startsWith(String.raw`\[已归档 `), 'notice prepended: ' + local.content.slice(0, 40));
    assert.equal(local.chapter_id, result.chapters[0].chapter_id);
    assert.ok(local.pending, 'content update queued');

    const push = await engine.sync({ mode: 'push' });
    assert.equal(push.push.errors.length, 0, JSON.stringify(push.push.errors));

    const remote = mock.findCard(card.id);
    assert.ok(remote.content.startsWith(String.raw`\[已归档 `), 'cloud content archived');
    const archiveRemote = mock.state.chapters.find((entry) => entry.name === '归档');
    assert.ok(archiveRemote, 'archive chapter created in the cloud');
    assert.ok(archiveRemote.card_ids.includes(card.id), 'card moved in the cloud');
    assert.equal(mock.state.chapters.at(-1).deck_id, deck.id);

    const again = await engine.archiveCards({ cards: [card.id] });
    assert.equal(again.already_archived, 1);
    assert.equal(again.content_updated, 0);
    assert.equal(again.moved, 0);
    const after = engine._internal.orderedCards().find((entry) => entry.id === card.id);
    assert.equal(after.content, local.content, 'second archive is a no-op');
    assert.equal((after.content.match(/\[已归档/g) || []).length, 1, 'only one notice');
  });
});

test('archive normalizes a legacy unescaped notice instead of adding a second one', async () => {
  await withFixture('旧归档说明', async ({ engine, mock, card }) => {
    const legacy = '[已归档 2023-11-14] 本卡片已归档，仅作历史保留，不再安排复习。\n\n正文';
    await engine.updateCard({ card: card.id, content: legacy });
    const result = await engine.archiveCards({ cards: [card.id] });
    assert.equal(result.content_updated, 1);
    const local = engine._internal.orderedCards().find((entry) => entry.id === card.id);
    assert.ok(local.content.startsWith(String.raw`\[已归档 `));
    assert.equal((local.content.match(/\[已归档/g) || []).length, 1, 'only one notice');
    assert.ok(local.content.endsWith('\n\n正文'));
    const push = await engine.sync({ mode: 'push' });
    assert.equal(push.push.errors.length, 0, JSON.stringify(push.push.errors));
    assert.match(mock.findCard(card.id).content, /^\\\[已归档 /);
  });
});

test('failure report exposes conflicts with recovery and clears after resolution', async () => {
  await withFixture('冲突测试', async ({ engine, mock, card }) => {
    await engine.updateCard({ card: card.id, content: '本地修改' });
    mock.remoteEditCard(card.id, '云端修改');
    const sync = await engine.sync({ mode: 'push' });
    assert.equal(sync.conflicts.length, 1, JSON.stringify(sync.conflicts));

    const report = await engine.failures();
    assert.equal(report.summary.conflicts, 1);
    assert.equal(report.conflicts.length, 1);
    const conflict = report.conflicts[0];
    assert.equal(conflict.card_id, card.id);
    assert.equal(conflict.entity, 'card');
    assert.equal(conflict.recovery.tool, 'markji_conflict_resolve');
    assert.ok(conflict.recovery.strategies.includes('keep_local'));
    assert.equal(conflict.recovery.arguments.id, conflict.id);

    const resolved = await engine.resolveConflict({ id: conflict.id, strategy: 'keep_local' });
    assert.equal(resolved.ok, true);
    const after = await engine.failures();
    assert.equal(after.summary.conflicts, 0);
    assert.equal(after.conflicts.length, 0);

    const push = await engine.sync({ mode: 'push' });
    assert.equal(push.push.errors.length, 0, JSON.stringify(push.push.errors));
    assert.equal(mock.findCard(card.id).content, '本地修改');
  });
});

test('failure report persists a failed push and suggests a retry', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-fail-'));
  const mock = await startMockMarkji({ token: 'fail-token' });
  let engine = null;
  let store = null;
  try {
    const deck = mock.newDeck('失败测试', { chapters: ['普通'] });
    const card = mock.newCard(deck.id, mock.state.chapters[0].id, '原始内容');
    let failUpdates = true;
    ({ engine, store } = makeEngine(dir, mock, (baseClient) =>
      new Proxy(baseClient, {
        get(target, prop) {
          if (prop === 'updateCard') {
            return async (...args) => {
              if (failUpdates) throw new MarkjiError({ code: 'server_error', message: 'injected update failure', status: 500, retriable: false });
              return target.updateCard(...args);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    ));
    await engine.ready();
    await engine.sync({ mode: 'pull', full: true });
    await engine.updateCard({ card: card.id, content: '本地修改' });

    const sync = await engine.sync({ mode: 'push' });
    assert.equal(sync.push.errors.length, 1, JSON.stringify(sync.push.errors));
    const report = await engine.failures();
    assert.equal(report.summary.failed_cards, 1);
    const failed = report.failed_cards[0];
    assert.equal(failed.id, card.id);
    assert.equal(failed.error.code, 'server_error');
    assert.equal(failed.error.op, 'card_update');
    assert.equal(failed.recovery.tool, 'markji_sync');
    assert.equal(failed.recovery.arguments.mode, 'push');

    failUpdates = false;
    const retry = await engine.sync({ mode: 'push' });
    assert.equal(retry.push.errors.length, 0, JSON.stringify(retry.push.errors));
    const after = await engine.failures();
    assert.equal(after.summary.failed_cards, 0);
    assert.equal(after.failed_cards.length, 0);
    assert.equal(after.summary.last_task_errors, 0, 'a successful retry clears the older failed task errors');
    assert.deepEqual(after.last_task_errors, []);
    assert.equal(mock.findCard(card.id).content, '本地修改');
  } finally {
    if (engine) await engine.stop();
    if (store) await store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a successful move does not clear a failed archive content update', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-archive-fail-'));
  const mock = await startMockMarkji({ token: 'archive-fail-token' });
  let engine = null;
  let store = null;
  try {
    const deck = mock.newDeck('归档失败测试', { chapters: ['普通'] });
    const card = mock.newCard(deck.id, mock.state.chapters[0].id, '原始内容');
    let failUpdates = true;
    ({ engine, store } = makeEngine(dir, mock, (baseClient) =>
      new Proxy(baseClient, {
        get(target, prop) {
          if (prop === 'updateCard') {
            return async (...args) => {
              if (failUpdates) throw new MarkjiError({ code: 'server_error', message: 'injected archive update failure', status: 500, retriable: false });
              return target.updateCard(...args);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    ));
    await engine.ready();
    await engine.sync({ mode: 'pull', full: true });

    const archived = await engine.archiveCards({ cards: [card.id] });
    assert.equal(archived.content_updated, 1);
    assert.equal(archived.moved, 1);

    const failed = await engine.sync({ mode: 'push' });
    assert.equal(failed.push.errors.length, 1, JSON.stringify(failed.push.errors));
    const local = engine._internal.orderedCards().find((entry) => entry.id === card.id);
    assert.equal(local.last_error.op, 'card_update', 'move success must not hide the failed content update');
    assert.equal(local.pending.content, local.content, 'archived content is still queued');
    const report = await engine.failures();
    assert.equal(report.summary.failed_cards, 1);
    assert.equal(report.failed_cards[0].error.op, 'card_update');

    failUpdates = false;
    const retry = await engine.sync({ mode: 'push' });
    assert.equal(retry.push.errors.length, 0, JSON.stringify(retry.push.errors));
    assert.equal(engine._internal.orderedCards().find((entry) => entry.id === card.id).last_error, undefined);
    assert.match(mock.findCard(card.id).content, /^\\\[已归档 \d{4}-\d{2}-\d{2}\\\]/);
    assert.equal((await engine.failures()).summary.failed_cards, 0);
  } finally {
    if (engine) await engine.stop();
    if (store) await store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('failure report surfaces a failed card move even when no content is pending', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-move-fail-'));
  const mock = await startMockMarkji({ token: 'move-fail-token' });
  let engine = null;
  let store = null;
  try {
    const deck = mock.newDeck('移动失败测试', { chapters: ['甲', '乙'] });
    const from = mock.state.chapters.find((entry) => entry.name === '甲');
    const to = mock.state.chapters.find((entry) => entry.name === '乙');
    const card = mock.newCard(deck.id, from.id, '原始内容');
    let failMoves = true;
    ({ engine, store } = makeEngine(dir, mock, (baseClient) =>
      new Proxy(baseClient, {
        get(target, prop) {
          if (prop === 'moveCards') {
            return async (...args) => {
              if (failMoves) throw new MarkjiError({ code: 'server_error', message: 'injected move failure', status: 500, retriable: false });
              return target.moveCards(...args);
            };
          }
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
    ));
    await engine.ready();
    await engine.sync({ mode: 'pull', full: true });
    await engine.moveCards({ cards: [card.id], to_chapter: to.id });

    const failed = await engine.sync({ mode: 'push' });
    assert.equal(failed.push.errors.length, 1, JSON.stringify(failed.push.errors));
    assert.equal(failed.push.errors[0].op, 'cards_move');
    const local = engine._internal.orderedCards().find((entry) => entry.id === card.id);
    assert.equal(local.pending, null, 'the failure is a move, not a content edit');
    const report = await engine.failures();
    assert.equal(report.summary.failed_cards, 1);
    assert.equal(report.failed_cards[0].id, card.id);
    assert.equal(report.failed_cards[0].error.op, 'cards_move');

    failMoves = false;
    const retry = await engine.sync({ mode: 'push' });
    assert.equal(retry.push.errors.length, 0, JSON.stringify(retry.push.errors));
    assert.equal((await engine.failures()).summary.failed_cards, 0);
    const remoteChapter = mock.state.chapters.find((entry) => entry.name === '乙');
    assert.ok(remoteChapter.card_ids.includes(card.id));
  } finally {
    if (engine) await engine.stop();
    if (store) await store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
