import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretBox } from '../lib/secret.js';
import { createSettings, readSettingsFile, registerSettingsRoute, settingsFilePath, SETTINGS_ROUTE } from '../lib/settings.js';

const VALID_KEY = 'a'.repeat(64);

function makeStore() {
  const values = new Map();
  return {
    values,
    async getSecret(key) { return values.get(key) ?? null; },
    async setSecret(key, value) { values.set(key, value); return true; },
    async deleteSecret(key) { values.delete(key); return true; },
  };
}

function makeClient() {
  const calls = [];
  return {
    calls,
    async validateApiKey(token) {
      calls.push(token);
      if (token !== VALID_KEY) throw new Error('invalid token');
      return true;
    },
  };
}

async function makeSettings(overrides = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dmb-settings-'));
  const active = join(root, 'active');
  const defaults = join(root, 'defaults');
  await mkdir(active, { recursive: true });
  await mkdir(defaults, { recursive: true });
  const store = makeStore();
  const client = makeClient();
  const secretBox = createSecretBox({ dataDir: active });
  let key = '';
  const engine = {
    async ready() {},
    status() {
      return { version: '2.8.0', cache_file: join(active, 'cache.db'), cache: { cards: 3 }, last_sync: 12345, active_task: null };
    },
  };
  const settings = createSettings({
    store,
    secretBox,
    client,
    engine,
    config: { dataDir: active },
    defaultDataDir: defaults,
    currentDataDir: active,
    getApiKey: () => key,
    setApiKey: (value) => { key = value; },
    keyReady: Promise.resolve(),
    log: () => {},
    ...overrides,
  });
  return { root, active, defaults, store, client, secretBox, settings, getKey: () => key };
}

test('setApiKey rejects malformed keys before any write', async () => {
  const env = await makeSettings();
  try {
    await assert.rejects(() => env.settings.setApiKey('not-a-key'), (error) => error.code === 'invalid_api_key');
    await assert.rejects(() => env.settings.testApiKey('z'.repeat(64)), (error) => error.code === 'invalid_api_key');
    assert.equal(env.store.values.size, 0);
    assert.equal(env.getKey(), '');
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('setApiKey tests, encrypts, and never returns the plaintext', async () => {
  const env = await makeSettings();
  try {
    const result = await env.settings.setApiKey(VALID_KEY.toUpperCase());
    assert.equal(result.ok, true);
    assert.equal(result.hasKey, true);
    assert.equal(result.tail, 'aaaa');
    assert.equal(env.getKey(), VALID_KEY);
    const cipher = env.store.values.get('api_key');
    assert.match(cipher, /^v1:/);
    assert.equal(cipher.includes(VALID_KEY), false);
    const status = await env.settings.status();
    assert.equal(status.key.configured, true);
    assert.equal(status.key.tail, 'aaaa');
    assert.equal(status.cache.cards, 3);
    assert.equal(status.data_dir.active, env.active);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('clearApiKey removes the ciphertext and the runtime key', async () => {
  const env = await makeSettings();
  try {
    await env.settings.setApiKey(VALID_KEY);
    const result = await env.settings.clearApiKey();
    assert.equal(result.hasKey, false);
    assert.equal(env.getKey(), '');
    assert.equal(env.store.values.has('api_key'), false);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('testApiKey does not persist a candidate key', async () => {
  const env = await makeSettings();
  try {
    const result = await env.settings.testApiKey(VALID_KEY);
    assert.equal(result.ok, true);
    assert.equal(env.store.values.size, 0);
    assert.equal(env.getKey(), '');
    assert.deepEqual(env.client.calls, [VALID_KEY]);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('testApiKey uses the saved Host key when omitted, without persisting or returning it', async () => {
  const env = await makeSettings();
  try {
    await env.settings.setApiKey(VALID_KEY);
    const cipher = env.store.values.get('api_key');
    env.client.calls.length = 0;
    const result = await env.settings.testApiKey();
    assert.deepEqual(result, { ok: true, tested: true });
    assert.deepEqual(env.client.calls, [VALID_KEY]);
    assert.equal(JSON.stringify(result).includes(VALID_KEY), false);
    assert.equal(env.store.values.get('api_key'), cipher);
    for (const invalid of ['', ' ', null, 42, 'bad']) {
      await assert.rejects(() => env.settings.testApiKey(invalid), error => error.code === 'invalid_api_key');
    }
    assert.deepEqual(env.client.calls, [VALID_KEY]);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('testApiKey waits for startup credentials and rejects a missing saved key', async () => {
  let current = '';
  let release;
  const keyReady = new Promise(resolve => { release = resolve; });
  const env = await makeSettings({ getApiKey: () => current, keyReady });
  try {
    const pending = env.settings.testApiKey();
    assert.equal(env.client.calls.length, 0);
    current = VALID_KEY;
    release();
    await pending;
    assert.deepEqual(env.client.calls, [VALID_KEY]);
    current = '';
    await assert.rejects(() => env.settings.testApiKey(), error => error.code === 'invalid_api_key');
  } finally {
    release();
    await rm(env.root, { recursive: true, force: true });
  }
});

test('setDataDir rejects relative paths and non-empty targets', async () => {
  const env = await makeSettings();
  try {
    await assert.rejects(() => env.settings.setDataDir('relative/cache'), (error) => error.code === 'invalid_data_dir');
    const occupied = join(env.root, 'occupied');
    await mkdir(occupied, { recursive: true });
    await writeFile(join(occupied, 'cache.db'), 'x');
    await assert.rejects(() => env.settings.setDataDir(occupied), (error) => error.code === 'target_not_empty');
    assert.equal(readSettingsFile(settingsFilePath(env.defaults)).dataDir, undefined);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('setDataDir copies cache.db and secret.key and persists the restart marker', async () => {
  const env = await makeSettings();
  try {
    await writeFile(join(env.active, 'cache.db'), 'sqlite-bytes');
    await writeFile(join(env.active, 'secret.key'), 'a'.repeat(43) + '=\n');
    const target = join(env.root, 'new-cache');
    const result = await env.settings.setDataDir(target);
    assert.equal(result.ok, true);
    assert.equal(result.restart_required, true);
    assert.equal(await readFile(join(target, 'cache.db'), 'utf8'), 'sqlite-bytes');
    assert.equal(await readFile(join(target, 'secret.key'), 'utf8'), 'a'.repeat(43) + '=\n');
    assert.equal(await readFile(join(env.active, 'cache.db'), 'utf8'), 'sqlite-bytes');
    const saved = readSettingsFile(settingsFilePath(env.defaults));
    assert.equal(saved.dataDir, target);
    const status = await env.settings.status();
    assert.equal(status.data_dir.saved, target);
    assert.equal(status.data_dir.restart_required, true);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('the authenticated settings route handles GET and validates POST actions', async () => {
  const env = await makeSettings();
  try {
    const routes = [];
    const ctx = {
      get(name) {
        if (name !== 'connection') return null;
        return { fetch: { register(def) { routes.push(def); return function () {}; } } };
      },
      effect(fn) { return fn(); },
    };
    registerSettingsRoute(ctx, env.settings);
    assert.equal(routes.length, 1);
    assert.equal(routes[0].path, SETTINGS_ROUTE);
    const getResponse = await routes[0].fetch(new Request('http://localhost' + SETTINGS_ROUTE));
    assert.equal(getResponse.status, 200);
    const body = await getResponse.json();
    assert.equal(body.ok, true);
    const badResponse = await routes[0].fetch(new Request('http://localhost' + SETTINGS_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'setApiKey', token: 'bad' }),
    }));
    assert.equal(badResponse.status, 400);
    const bad = await badResponse.json();
    assert.equal(bad.error.code, 'invalid_api_key');
    await env.settings.setApiKey(VALID_KEY);
    const testResponse = await routes[0].fetch(new Request('http://localhost' + SETTINGS_ROUTE, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'testApiKey' }),
    }));
    assert.equal(testResponse.status, 200);
    assert.deepEqual(await testResponse.json(), { ok: true, tested: true });
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});

test('settings status reports a missing API Key without throwing', async () => {
  const env = await makeSettings();
  try {
    const status = await env.settings.status();
    assert.equal(status.configured, false);
    assert.equal(status.key.hasKey, false);
    assert.equal(status.cache.cards, 3);
  } finally {
    await rm(env.root, { recursive: true, force: true });
  }
});
