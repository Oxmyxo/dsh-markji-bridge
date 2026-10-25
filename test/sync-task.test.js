/**
 * Background sync task tests (Lead-owned, offline).
 *
 * Contract: DESIGN.md "Background sync tasks and crash recovery".
 * Proves: markji_sync returns immediately while the pipeline runs in the
 * background, only one task runs at a time, progress is persisted, a task left
 * 'running' by a dead host becomes 'interrupted' after reload and resumes through
 * the same handle, and a resumed pull adopts cards the provider already created
 * instead of duplicating them.
 *
 * Run: node --test "test/sync-task.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startMockMarkji } from './mock-server.mjs';
import { createClient } from '../lib/api.js';
import { createLimiter } from '../lib/rate-limit.js';
import { createStore } from '../lib/store.js';
import { createEngine } from '../lib/sync.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Read committed rows straight from cache.db (the store keeps the handle open). */
function readDb(dir, sql, params = []) {
  const handle = new DatabaseSync(join(dir, 'cache.db'), { readOnly: true });
  try {
    return handle.prepare(sql).all(...params);
  } finally {
    handle.close();
  }
}
function readTask(dir, taskId) {
  const rows = readDb(dir, 'SELECT data FROM tasks WHERE task_id = ?', [taskId]);
  return rows.length === 0 ? null : JSON.parse(rows[0].data);
}
function readMeta(dir, key) {
  const rows = readDb(dir, 'SELECT value FROM meta WHERE key = ?', [key]);
  return rows.length === 0 ? null : rows[0].value;
}

function wrapClient(client, { delayListChaptersMs = 0, hangListFolders = false } = {}) {
  return new Proxy(client, {
    get(target, prop, receiver) {
      if (prop === 'listFolders' && hangListFolders) return () => new Promise(() => {});
      if (prop === 'listChapters' && delayListChaptersMs > 0) {
        return async (...args) => {
          await sleep(delayListChaptersMs);
          return target.listChapters(...args);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function makeEngine(dir, mock, options = {}) {
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
  const client = createClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs: config.requestTimeoutMs, maxRetries: config.maxRetries, limiter, log: () => {} });
  const store = createStore({ dataDir: dir, log: () => {}, clock: Date.now });
  const engine = createEngine({ client: wrapClient(client, options), store, config, log: () => {}, clock: Date.now });
  return { engine, store };
}

test('startSync returns a handle immediately and reports progress', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-task-'));
  const mock = await startMockMarkji({ token: 'task-token-1' });
  let engine = null;
  let store = null;
  try {
    mock.newDeck('任务牌组 A', { chapters: ['甲', '乙'] });
    mock.newDeck('任务牌组 B', { chapters: ['丙'] });
    ({ engine, store } = makeEngine(dir, mock, { delayListChaptersMs: 150 }));
    await engine.ready();

    const startedAt = Date.now();
    const first = await engine.startSync({ mode: 'pull', full: true });
    const elapsed = Date.now() - startedAt;
    assert.ok(first && first.task, 'task handle returned');
    assert.equal(first.task.status, 'running');
    assert.ok(String(first.task.task_id).startsWith('sync_'), 'task id shape: ' + first.task.task_id);
    assert.ok(elapsed < 150, 'startSync must not wait for the slow pull (took ' + elapsed + 'ms)');

    const second = await engine.startSync({ mode: 'pull' });
    assert.equal(second.already_running, true, 'second call reports already_running');
    assert.equal(second.task.task_id, first.task.task_id, 'same running task is returned');

    const progress = await engine.syncTaskStatus({ task_id: first.task.task_id });
    assert.equal(progress.task.task_id, first.task.task_id, 'task_id selects one task');
    assert.equal(progress.task.status, 'running', 'still running while the delayed pull is in flight');
    assert.equal(progress.tasks, undefined, 'single-task progress does not return history');

    const done = await engine.waitForTask(first.task.task_id, 20000);
    assert.equal(done.status, 'completed', 'task completes: ' + JSON.stringify(done.error));
    assert.ok(done.report && done.report.pull, 'completed task carries the report');
    assert.equal(done.report.pull.decks, 2, 'both decks pulled');
    assert.equal(done.progress.decks_total, 2, 'plan progress persisted');
    assert.equal(done.progress.decks_done, 2, 'per-deck progress persisted');
    assert.equal(done.resume_count, 0);

    const persisted = readTask(dir, first.task.task_id);
    assert.equal(persisted.status, 'completed', 'task status persisted in cache.db');
    assert.equal(persisted.report.pull.decks, 2);
    assert.equal(JSON.parse(readMeta(dir, 'meta.last_sync')).mode, 'pull');

    await assert.rejects(engine.syncTaskStatus({ task_id: 'sync_missing' }), /unknown_task|No sync task/i);
    await assert.rejects(engine.startSync({ resume: first.task.task_id }), /task_not_resumable|only an interrupted/i);
  } finally {
    if (engine) await engine.stop();
    if (store) await store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a task left running by a dead host becomes interrupted and resumes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-task-'));
  const mock = await startMockMarkji({ token: 'task-token-2' });
  try {
    mock.newDeck('恢复牌组', { chapters: ['甲'] });
    // Engine A "dies" with the task in flight: listFolders never resolves, so the
    // pipeline makes no progress and no debounced save can overwrite the file.
    const a = makeEngine(dir, mock, { hangListFolders: true });
    const started = await a.engine.startSync({ mode: 'auto' });
    const taskId = started.task.task_id;
    await sleep(40);
    const rawBefore = readTask(dir, taskId);
    assert.equal(rawBefore.status, 'running', 'dead host persisted a running task');
    // Simulate process death: the owner pid is gone and the SQLite handle is
    // closed without the engine cleanup. (Tests share one real pid, so rewrite
    // the owner to a provably dead pid before closing.)
    a.store.cache.tasks[taskId].owner = { pid: 99999999, host: hostname() };
    await a.store.saveNow();
    await a.store.close();

    // Engine B starts on the same data dir after the "crash".
    const b = makeEngine(dir, mock);
    await b.engine.start();
    const recovered = await b.engine.syncTaskStatus({ task_id: taskId });
    assert.equal(recovered.task.status, 'interrupted', 'reload marks the task interrupted');
    assert.equal(recovered.task.error.code, 'interrupted');
    assert.match(recovered.task.hint, /resume/);

    const resumed = await b.engine.startSync({ resume: taskId });
    assert.equal(resumed.task.status, 'running');
    assert.equal(resumed.task.resume_count, 1, 'resume_count increments');
    assert.equal(resumed.task.task_id, taskId, 'same handle is reused');
    const done = await b.engine.waitForTask(taskId, 20000);
    assert.equal(done.status, 'completed', 'resumed task completes: ' + JSON.stringify(done.error));
    assert.ok(done.report.pull.decks >= 1);
    assert.equal(done.resume_count, 1);
    const rawAfter = readTask(dir, taskId);
    assert.equal(rawAfter.status, 'completed');
    await b.engine.stop();
    await b.store.close();
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('resuming adopts cards the provider already created instead of duplicating them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-task-'));
  const mock = await startMockMarkji({ token: 'task-token-3' });
  try {
    const deck = mock.newDeck('去重牌组', { chapters: ['甲'] });
    const chapter = mock.state.chapters.find((c) => c.deck_id === deck.id && c.name === '甲');
    const { engine, store } = makeEngine(dir, mock);
    await engine.listDecks({ refresh: true });
    const local = await engine.createCard({ deck: deck.id, chapter: chapter.id, content: '崩溃前已创建的内容' });
    assert.ok(String(local.card_id).startsWith('local_'), 'queued locally: ' + local.card_id);

    // The provider already applied the create; the host died before the local id
    // remap was persisted (simulated by a running task plus an unknown remote card).
    mock.newCard(deck.id, chapter.id, '崩溃前已创建的内容');
    assert.equal(mock.state.cards.filter((c) => c.content === '崩溃前已创建的内容').length, 1);

    const taskId = 'sync_crashresume01';
    store.cache.tasks[taskId] = {
      id: taskId,
      mode: 'auto',
      full: false,
      status: 'running',
      started_at: Date.now(),
      updated_at: Date.now(),
      finished_at: null,
      stage: 'push',
      progress: { message: 'push: cards_create', decks_total: 1, decks_done: 1, cards: 1, cards_deleted: 0, adopted_cards: 0, adopted_chapters: 0, conflicts_created: 0, chapters_created: 0, chapters_renamed: 0, chapters_sorted: 0, cards_created: 0, cards_updated: 0, cards_moved: 0, errors: 0 },
      resume_count: 0,
      error: null,
      report: null,
    };
    await store.saveNow();
    await store.close();

    const b = makeEngine(dir, mock);
    await b.engine.start();
    const interrupted = await b.engine.syncTaskStatus({ task_id: taskId });
    assert.equal(interrupted.task.status, 'interrupted');

    const resumed = await b.engine.startSync({ resume: taskId });
    assert.equal(resumed.task.status, 'running');
    const done = await b.engine.waitForTask(taskId, 20000);
    assert.equal(done.status, 'completed', 'resume completes: ' + JSON.stringify(done.error));
    assert.equal(done.report.pull.adopted_cards, 1, 'already-created card was adopted: ' + JSON.stringify(done.report.pull));
    assert.equal((done.report.push && done.report.push.cards_created) || 0, 0, 'no card create was retried');
    assert.equal(mock.state.cards.filter((c) => c.content === '崩溃前已创建的内容').length, 1, 'provider has exactly one card');
    const ids = readDb(dir, 'SELECT id FROM cards');
    assert.equal(ids.some((row) => row.id === local.card_id), false, 'local placeholder removed');
    assert.ok(ids.some((row) => !String(row.id).startsWith('local_')), 'real id adopted');
    await b.engine.stop();
    await b.store.close();
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});


test('watchTaskProgress and watchTask mirror live and terminal state', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-task-watch-'));
  const mock = await startMockMarkji({ token: 'task-token-watch' });
  let engine = null;
  let store = null;
  try {
    mock.newDeck('监视牌组 A', { chapters: ['甲'] });
    mock.newDeck('监视牌组 B', { chapters: ['乙'] });
    ({ engine, store } = makeEngine(dir, mock, { delayListChaptersMs: 100 }));
    await engine.ready();
    const started = await engine.startSync({ mode: 'pull', full: true });
    const taskId = started.task.task_id;
    const progress = [];
    const terminal = [];
    assert.equal(engine.watchTaskProgress(taskId, (view) => progress.push(view)), true);
    assert.equal(engine.watchTask(taskId, (view) => terminal.push(view)), true);
    const done = await engine.waitForTask(taskId, 20000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    assert.equal(terminal.length, 1, 'terminal watcher runs exactly once');
    assert.equal(terminal[0].status, 'completed');
    assert.ok(progress.length > 0, 'progress watcher receives at least the seed snapshot');
    assert.equal(progress[0].task_id, taskId);
    await engine.stop();
    await store.close();
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('cancelTask stops a running task and leaves it resumable', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-task-cancel-'));
  const mock = await startMockMarkji({ token: 'task-token-cancel' });
  let engine = null;
  let store = null;
  try {
    mock.newDeck('取消牌组 A', { chapters: ['甲'] });
    mock.newDeck('取消牌组 B', { chapters: ['乙'] });
    ({ engine, store } = makeEngine(dir, mock, { delayListChaptersMs: 200 }));
    await engine.ready();
    const started = await engine.startSync({ mode: 'pull', full: true });
    const taskId = started.task.task_id;
    assert.equal(engine.cancelTask(taskId, 'test cancel'), true);
    const stopped = await engine.waitForTask(taskId, 20000);
    assert.equal(stopped.status, 'interrupted', JSON.stringify(stopped));
    assert.equal(stopped.error.code, 'cancelled');
    const resumed = await engine.startSync({ mode: 'pull', full: true, resume: taskId });
    assert.equal(resumed.task.task_id, taskId);
    const done = await engine.waitForTask(taskId, 20000);
    assert.equal(done.status, 'completed', JSON.stringify(done.error));
    await engine.stop();
    await store.close();
  } finally {
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
