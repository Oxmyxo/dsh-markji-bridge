/**
 * Multi-process cache tests (offline).
 *
 * Run: node --test "test/multiprocess.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, stat, access } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { startMockMarkji } from './mock-server.mjs';
import { createClient } from '../lib/api.js';
import { createLimiter } from '../lib/rate-limit.js';
import { createStore } from '../lib/store.js';
import { createEngine } from '../lib/sync.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeCard(id, deck = 'd1', chapter = 'c1', content = 'content') {
  return { id, deck_id: deck, chapter_id: chapter, content, grammar_version: 3, pending: null, conflict: null, cloud: null, updated_time: '2026-01-01T00:00:00.000Z' };
}

function makeEngine(dir, mock) {
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
  const engine = createEngine({ client, store, config, log: () => {}, clock: Date.now });
  return { engine, store };
}

test('two stores see each other writes through refreshIfChanged', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-mp-store-'));
  let a = null;
  let b = null;
  try {
    a = createStore({ dataDir: dir, log: () => {}, saveDebounceMs: 0 });
    b = createStore({ dataDir: dir, log: () => {}, saveDebounceMs: 0 });
    await a.load();
    await b.load();

    a.cache.cards.mp1 = fakeCard('mp1', 'd1', 'c1', 'from-a');
    await a.saveNow();
    assert.equal(await b.refreshIfChanged(), true, 'B reloads A write');
    assert.equal(b.cache.cards.mp1.content, 'from-a');

    b.cache.cards.mp2 = fakeCard('mp2', 'd1', 'c1', 'from-b');
    await b.saveNow();
    assert.equal(await a.refreshIfChanged(), true, 'A reloads B write');
    assert.equal(a.cache.cards.mp2.content, 'from-b');
    assert.equal(a.cache.cards.mp1.content, 'from-a', 'A keeps the row it already had');
  } finally {
    if (a) await a.close();
    if (b) await b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the writer lock serializes two stores and leaves no lock file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-mp-lock-'));
  let a = null;
  let b = null;
  try {
    a = createStore({ dataDir: dir, log: () => {} });
    b = createStore({ dataDir: dir, log: () => {} });
    await a.load();
    await b.load();
    let aInside = 0;
    let bInside = 0;
    const hold = a.withWriteLock(async () => {
      aInside = Date.now();
      await sleep(300);
    }, { timeoutMs: 5000 });
    await sleep(50);
    const started = Date.now();
    await b.withWriteLock(async () => {
      bInside = Date.now();
    }, { timeoutMs: 5000 });
    await hold;
    assert.ok(aInside > 0, 'A entered its critical section');
    assert.ok(bInside - aInside >= 200, 'B waited for A (waited ' + String(bInside - aInside) + 'ms)');
    assert.ok(Date.now() - started >= 200);
    await assert.rejects(stat(join(dir, 'cache.write.lock')), /ENOENT/);
  } finally {
    if (a) await a.close();
    if (b) await b.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stale lock owned by a dead pid is reclaimed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-mp-stale-'));
  let store = null;
  try {
    store = createStore({ dataDir: dir, log: () => {} });
    await store.load();
    await writeFile(join(dir, 'cache.write.lock'), JSON.stringify({ pid: 99999999, host: hostname(), at: 0 }));
    const started = Date.now();
    await store.withWriteLock(async () => {}, { timeoutMs: 2000 });
    assert.ok(Date.now() - started < 1500, 'stale lock is reclaimed instead of waiting for the 2-minute TTL');
    await assert.rejects(stat(join(dir, 'cache.write.lock')), /ENOENT/);
  } finally {
    if (store) await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('the writer lock is respected by a real separate process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-mp-child-'));
  let store = null;
  let child = null;
  try {
    store = createStore({ dataDir: dir, log: () => {} });
    await store.load();
    const marker = join(dir, 'child-locked.marker');
    child = spawn(process.execPath, [join(import.meta.dirname, 'mp-holder.mjs'), dir, marker], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const childExited = new Promise((resolve, reject) => {
      child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('child exited ' + String(code)))));
      child.once('error', reject);
    });
    const startedAt = Date.now();
    let ready = false;
    while (Date.now() - startedAt < 3000) {
      try {
        await access(marker);
        ready = true;
        break;
      } catch {
        await sleep(25);
      }
    }
    assert.equal(ready, true, 'child acquired the lock');
    const waitStarted = Date.now();
    await store.withWriteLock(async () => {}, { timeoutMs: 5000 });
    const waited = Date.now() - waitStarted;
    assert.ok(waited >= 200, 'parent waited for the child lock (waited ' + String(waited) + 'ms)');
    await childExited;
    child = null;
  } finally {
    if (child) child.kill();
    if (store) await store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a started sync task waits for the writer lock instead of failing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-mp-task-'));
  const mock = await startMockMarkji({ token: 'mp-task-token' });
  let fixture = null;
  try {
    mock.newDeck('锁任务牌组', { chapters: ['甲'] });
    fixture = makeEngine(dir, mock);
    await fixture.engine.ready();
    const hold = fixture.store.withWriteLock(async () => {
      await sleep(300);
    }, { timeoutMs: 5000 });
    const { task } = await fixture.engine.startSync({ mode: 'pull' });
    let sawWaiting = false;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const status = await fixture.engine.syncTaskStatus({ task_id: task.task_id });
      if (status.tasks[0].stage === 'waiting_lock') {
        sawWaiting = true;
        break;
      }
      await sleep(25);
    }
    await hold;
    const done = await fixture.engine.waitForTask(task.task_id, 5000);
    assert.equal(done.status, 'completed', JSON.stringify(done));
    assert.equal(sawWaiting, true, 'task exposed the waiting_lock stage while blocked');
  } finally {
    if (fixture) await fixture.engine.stop();
    if (fixture) await fixture.store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('an engine read sees writes pushed by another engine process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-mp-engine-'));
  const mock = await startMockMarkji({ token: 'mp-token' });
  let a = null;
  let b = null;
  try {
    const deck = mock.newDeck('多进程牌组', { chapters: ['甲'] });
    const card = mock.newCard(deck.id, mock.state.chapters[0].id, '原始内容');
    a = makeEngine(dir, mock);
    b = makeEngine(dir, mock);
    await a.engine.ready();
    await b.engine.ready();
    await a.engine.sync({ mode: 'pull', full: true });
    await b.engine.sync({ mode: 'pull', full: true });

    await a.engine.updateCard({ card: card.id, content: '进程 A 的修改' });
    const seenByB = await b.engine.getCard({ card: card.id });
    assert.equal(seenByB.card.content, '进程 A 的修改');
    assert.equal(seenByB.card.status, 'dirty');

    await a.engine.sync({ mode: 'push' });
    const fresh = await b.engine.getCard({ card: card.id });
    assert.equal(fresh.card.content, '进程 A 的修改');
    assert.equal(fresh.card.status, 'synced');
    assert.equal(mock.findCard(card.id).content, '进程 A 的修改');
  } finally {
    if (a) await a.engine.stop();
    if (a) await a.store.close();
    if (b) await b.engine.stop();
    if (b) await b.store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test('a second engine start keeps a live task owned by another process', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'markji-mp-owner-'));
  const mock = await startMockMarkji({ token: 'mp-owner-token' });
  let a = null;
  let b = null;
  try {
    mock.newDeck('任务归属牌组', { chapters: ['甲'] });
    a = makeEngine(dir, mock);
    b = makeEngine(dir, mock);
    await a.engine.start();
    await b.engine.ready();

    const hold = a.store.withWriteLock(async () => {
      await sleep(400);
    }, { timeoutMs: 5000 });
    const { task } = await a.engine.startSync({ mode: 'pull' });

    // Starting a second plugin instance must not treat the first process's live
    // running task as a crashed task.
    await b.engine.start();
    const seen = await b.engine.syncTaskStatus({ task_id: task.task_id });
    assert.equal(seen.tasks[0].status, 'running');

    const duplicate = await b.engine.startSync({ mode: 'pull' });
    assert.equal(duplicate.already_running, true);
    assert.equal(duplicate.task.task_id, task.task_id);

    await hold;
    const done = await a.engine.waitForTask(task.task_id, 5000);
    assert.equal(done.status, 'completed', JSON.stringify(done));
  } finally {
    if (a) await a.engine.stop();
    if (a) await a.store.close();
    if (b) await b.engine.stop();
    if (b) await b.store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
});
