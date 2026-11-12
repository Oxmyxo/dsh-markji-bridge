// Offline regression contract: provider HTTP-200 failure envelopes and safe diagnostics.
// Every HTTP request uses injected fetchImpl; this file never opens a socket,
// loads a real store/settings/secret, or reads the user's cache.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient, MarkjiError } from '../lib/api.js';
import { createEngine } from '../lib/sync.js';

const FAKE_KEY = 'offline-provider-transient-test-key';
const internalErrors = [{ code: 'common_internal_error', msg: 'Internal server error' }];
const reply = (body, status = 200) => new Response(JSON.stringify(body), { status });
const rejected = (errors = internalErrors, status = 200) => reply({ success: false, errors, data: {} }, status);
const accepted = (data) => reply({ success: true, errors: [], data });

function harness(responder, maxRetries = 2) {
  const calls = [], sleeps = [], logs = [];
  let acquires = 0;
  const client = createClient({
    apiKey: FAKE_KEY,
    baseUrl: 'https://offline.invalid/open',
    maxRetries,
    limiter: { acquire: async () => { acquires += 1; } },
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return responder({ url, init, attempt: calls.length });
    },
    sleep: async (ms) => { sleeps.push(ms); },
    random: () => 0,
    now: () => 123456,
    log: (level, message) => { logs.push({ level, message }); },
  });
  return { client, calls, sleeps, logs, acquires: () => acquires };
}

function requestIs(error, method, path) {
  assert.ok(error instanceof MarkjiError);
  assert.deepEqual(error.request, { method, path });
  assert.deepEqual(Object.keys(error.request).sort(), ['method', 'path']);
  assert.ok(!JSON.stringify(error.request).includes(FAKE_KEY));
  assert.ok(!/[?#]/.test(error.request.path));
  return true;
}

test('GET HTTP200 common_internal_error retries then succeeds through the limiter', async () => {
  const h = harness(({ attempt }) => attempt < 3 ? rejected() : accepted({ folders: [{ id: 'f1' }] }));
  assert.deepEqual(await h.client.listFolders(), [{ id: 'f1' }]);
  assert.equal(h.calls.length, 3);
  assert.equal(h.acquires(), 3);
  assert.deepEqual(h.sleeps, [500, 1000]);
  assert.equal(h.client.stats().requests, 3);
  assert.equal(h.client.stats().retries, 2);
  assert.equal(h.client.stats().lastStatus, 200);
  assert.equal(h.client.stats().lastErrorAt, 123456);
  assert.ok(h.calls.every(({ init }) => init.method === 'GET'));
  assert.ok(!JSON.stringify(h.logs).includes(FAKE_KEY));
});

test('GET repeated internal failure exhausts the existing retry budget and keeps provider details', async () => {
  const h = harness(() => rejected());
  await assert.rejects(h.client.listDecksPage({ offset: 3, limit: 1, folder_id: 'private-query-marker' }), (error) => {
    requestIs(error, 'GET', '/markji/decks');
    assert.equal(error.code, 'common_internal_error');
    assert.equal(error.status, 200);
    assert.equal(error.retriable, true);
    assert.deepEqual(error.details, internalErrors, 'request metadata must not wrap or replace details');
    assert.ok(!JSON.stringify(error.request).includes('private-query-marker'));
    return true;
  });
  assert.equal(h.calls.length, 3);
  assert.equal(h.acquires(), 3);
  assert.deepEqual(h.sleeps, [500, 1000]);
});

test('maxRetries zero never retries even the allowed GET internal envelope', async () => {
  const h = harness(() => rejected(), 0);
  await assert.rejects(h.client.listFolders(), (error) => requestIs(error, 'GET', '/markji/decks/folders'));
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.sleeps, []);
});

test('HTTP201 internal envelope does not enter the HTTP200-only GET retry rule', async () => {
  const h = harness(() => rejected(internalErrors, 201), 3);
  await assert.rejects(h.client.listFolders(), (error) => {
    requestIs(error, 'GET', '/markji/decks/folders');
    assert.equal(error.status, 201);
    assert.equal(error.code, 'common_internal_error');
    assert.equal(error.retriable, false);
    assert.deepEqual(error.details, internalErrors);
    return true;
  });
  assert.equal(h.calls.length, 1);
  assert.equal(h.acquires(), 1);
  assert.deepEqual(h.sleeps, []);
  assert.equal(h.client.stats().retries, 0);
});

test('GET other provider errors and malformed HTTP200 bodies are not made retriable', async (t) => {
  const cases = [
    ['validation', () => rejected([{ code: 'common_invalid_param', msg: 'Invalid parameter' }]), 'common_invalid_param'],
    ['authorization', () => rejected([{ code: 'common_unauthorized', msg: 'Unauthorized' }]), 'common_unauthorized'],
    ['invalid JSON', () => new Response('<html>not JSON</html>', { status: 200 }), 'bad_response'],
    ['missing data', () => reply({ success: true, errors: [] }), 'bad_response'],
    ['missing success', () => reply({ errors: internalErrors, data: {} }), 'common_internal_error'],
  ];
  for (const [label, responder, code] of cases) await t.test(label, async () => {
    const h = harness(responder);
    await assert.rejects(h.client.listFolders(), (error) => {
      requestIs(error, 'GET', '/markji/decks/folders');
      assert.equal(error.code, code);
      assert.equal(error.retriable, false);
      assert.equal(error.status, 200);
      return true;
    });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(h.sleeps, []);
  });
});

test('POST common_internal_error never retries: create/update/move/upload and read-like query', async (t) => {
  const cases = [
    ['createCard', '/markji/decks/d1/chapters/c1/cards', (c) => c.createCard({ deck: 'd1', chapter: 'c1', card: { content: 'private-card-body', grammar_version: 3 } })],
    ['updateCard', '/markji/decks/d1/cards/k1', (c) => c.updateCard({ deck_id: 'd1', card_id: 'k1', card: { content: 'private-card-body' } })],
    ['moveCards', '/markji/decks/d1/chapters/c1/cards/move', (c) => c.moveCards({ deck: 'd1', chapter: 'c1', card_ids: ['k1'], to_chapter_id: 'c2' })],
    ['uploadFile', '/markji/files', (c) => c.uploadFile({ data: new Uint8Array([1]), filename: 'offline.png' })],
    ['queryFiles', '/markji/files/query', (c) => c.queryFiles({ ids: ['private-query-marker'] })],
  ];
  for (const [label, path, run] of cases) await t.test(label, async () => {
    const h = harness(() => rejected(), 3);
    await assert.rejects(run(h.client), (error) => {
      requestIs(error, 'POST', path);
      assert.equal(error.code, 'common_internal_error');
      assert.equal(error.status, 200);
      assert.equal(error.retriable, false);
      assert.deepEqual(error.details, internalErrors);
      return true;
    });
    assert.equal(h.calls.length, 1);
    assert.equal(h.acquires(), 1);
    assert.deepEqual(h.sleeps, []);
    assert.ok(!JSON.stringify(h.logs).includes('private-card-body'));
  });
});

test('HTTP and transport failures also carry safe method/path diagnostics', async (t) => {
  const cases = [
    ['HTTP401', () => rejected([{ code: 'common_unauthorized', msg: 'Unauthorized' }], 401), 401],
    ['network', () => { throw new TypeError('offline fetch failed'); }, null],
    ['timeout', () => { throw new DOMException('offline timeout', 'TimeoutError'); }, null],
  ];
  for (const [label, responder, status] of cases) await t.test(label, async () => {
    const h = harness(responder, 0);
    await assert.rejects(h.client.getDeck('d1', { with_root: true }), (error) => {
      requestIs(error, 'GET', '/markji/decks/d1');
      assert.equal(error.status, status);
      return true;
    });
    assert.equal(h.calls.length, 1);
  });
});

// Minimal isolated memory store: exercises the real task catch/view code without
// importing store.js or reading/writing any filesystem cache or credentials.
function memoryStore() {
  const cache = {
    meta: {}, folders: {}, decks: {}, chapters: {}, cards: {},
    conflicts: [], moves: [], tasks: {},
  };
  const store = {
    cache,
    load: async () => cache,
    refreshIfChanged: async () => {},
    withWriteLock: async (operation) => operation(),
    markDirty: () => {},
    saveNow: async () => {},
  };
  return store;
}

test('failed full-pull task preserves safe API diagnostics at zero decks', async () => {
  const h = harness(() => rejected(), 1);
  const store = memoryStore();
  const engine = createEngine({ client: h.client, store, config: { autoSync: false } });
  try {
    const started = await engine.startSync({ mode: 'pull', full: true });
    const done = await engine.waitForTask(started.task.task_id, 1000);
    assert.equal(done.status, 'failed');
    assert.equal(done.progress.decks_total, 0);
    assert.equal(done.error.code, 'common_internal_error');
    assert.equal(done.error.status, 200);
    assert.equal(done.error.retriable, true);
    assert.deepEqual(done.error.request, { method: 'GET', path: '/markji/decks/folders' });
    assert.equal(done.error.details, undefined, 'do not persist the raw provider envelope in tasks');
    assert.ok(!JSON.stringify(done.error).includes(FAKE_KEY));
    assert.equal(h.calls.length, 2);
    const persisted = store.cache.tasks[started.task.task_id];
    assert.deepEqual(persisted.error, done.error);
  } finally {
    await engine.stop();
  }
});
