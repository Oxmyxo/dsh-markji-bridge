// dsh-markji-bridge: Host-side settings RPC.
//
// The browser half calls these methods through the authenticated fetch carrier.
// The API Key is only ever written encrypted into cache.db; the response exposes
// hasKey and the last four characters, never the value.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { accessSync, constants as fsConstants } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';

export const SETTINGS_ROUTE = '/api/dsh-markji-bridge/settings';
export const SETTINGS_FILENAME = 'settings.json';
const API_KEY_RE = /^[0-9a-fA-F]{64}$/;
const MAX_PATH_CHARS = 4096;

export class SettingsError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'SettingsError';
    this.code = code;
    this.details = details;
  }
}

export function settingsFilePath(defaultDataDir) {
  return join(defaultDataDir, SETTINGS_FILENAME);
}

export function readSettingsFile(file, log = () => {}) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return parsed !== null && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    if (error && error.code !== 'ENOENT') log('warn', 'could not read settings.json: ' + (error && error.message ? error.message : String(error)));
    return {};
  }
}

function writeSettingsFile(file, data) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = file + '.tmp-' + process.pid;
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
    try { renameSync(temp, file); } catch (error) {
      if (!existsSync(file)) throw error;
      unlinkSync(file);
      renameSync(temp, file);
    }
  } finally {
    if (existsSync(temp)) {
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

function isSystemPath(target) {
  if (process.platform !== 'win32') return target === '/' || target === '/root';
  const normalized = target.replace(/\/+$/, '').toLowerCase();
  const fixed = [
    'c:\\windows',
    'c:\\program files',
    'c:\\program files (x86)',
    'c:\\programdata',
    'c:\\users\\all users',
    'c:\\users\\default',
  ];
  return /^[a-z]:$/.test(normalized) || fixed.some((entry) => normalized === entry || normalized.startsWith(entry + '\\'));
}

function validateDataDir(value) {
  if (typeof value !== 'string' || value.trim() === '') throw new SettingsError('invalid_data_dir', 'dataDir must be a non-empty path');
  const text = value.trim();
  if (text.length > MAX_PATH_CHARS) throw new SettingsError('invalid_data_dir', 'dataDir is too long');
  if (!isAbsolute(text)) throw new SettingsError('invalid_data_dir', 'dataDir must be an absolute path');
  const target = resolve(text);
  if (isSystemPath(target)) throw new SettingsError('invalid_data_dir', 'dataDir must not be a system directory');
  return target;
}

function copyIfExists(source, target) {
  if (!existsSync(source)) return false;
  const temp = target + '.migrating-' + process.pid;
  try {
    copyFileSync(source, temp);
    try {
      renameSync(temp, target);
    } catch (error) {
      if (existsSync(target)) throw new SettingsError('target_not_empty', 'the target directory already contains a cache');
      throw error;
    }
    return true;
  } finally {
    if (existsSync(temp)) {
      try { unlinkSync(temp); } catch { /* best effort */ }
    }
  }
}

function tailOf(value) {
  return typeof value === 'string' && value.length >= 4 ? value.slice(-4) : null;
}

/**
 * @param options.store      cache store
 * @param options.secretBox  lib/secret.js box
 * @param options.client     Markji HTTP client
 * @param options.engine     sync engine (status)
 * @param options.config     normalized config
 * @param options.defaultDataDir stable default dir that holds settings.json
 * @param options.currentDataDir active store dir
 * @param options.getApiKey  () => current plaintext key (Host only)
 * @param options.setApiKey  (key) => void after the store write succeeds
 * @param options.keyReady   promise that settles after startup credential migration
 * @param options.log        logger
 */
export function createSettings(options) {
  const {
    store,
    secretBox,
    client,
    engine,
    config,
    defaultDataDir,
    currentDataDir,
    getApiKey,
    setApiKey,
    getKeyError = null,
    keyReady,
    log = () => {},
  } = options;
  const file = settingsFilePath(defaultDataDir);
  let keyError = null;

  function keyInfo() {
    const key = typeof getApiKey === 'function' ? getApiKey() : '';
    return {
      configured: typeof key === 'string' && key.length > 0,
      hasKey: typeof key === 'string' && key.length > 0,
      tail: tailOf(key),
      source: secretBox && typeof secretBox.source === 'string' ? secretBox.source : null,
      error: typeof getKeyError === 'function' ? getKeyError() : keyError,
    };
  }

  async function ready() {
    if (keyReady && typeof keyReady.then === 'function') {
      try { await keyReady; } catch { /* status still explains the failure */ }
    }
  }

  async function status() {
    await ready();
    let engineStatus = null;
    try {
      if (engine && typeof engine.ready === 'function') await engine.ready();
      engineStatus = engine && typeof engine.status === 'function' ? engine.status() : null;
    } catch (error) {
      log('warn', 'settings status failed: ' + (error && error.message ? error.message : String(error)));
    }
    const info = keyInfo();
    const saved = readSettingsFile(file, log);
    const savedDataDir = typeof saved.dataDir === 'string' && saved.dataDir !== '' ? resolve(saved.dataDir) : null;
    const activeDataDir = currentDataDir;
    return {
      ok: true,
      version: engineStatus && engineStatus.version ? engineStatus.version : null,
      key: info,
      configured: info.configured,
      cache_file: engineStatus && engineStatus.cache_file ? engineStatus.cache_file : null,
      cache: engineStatus && engineStatus.cache ? engineStatus.cache : null,
      last_sync: engineStatus && engineStatus.last_sync ? engineStatus.last_sync : null,
      active_task: engineStatus && engineStatus.active_task ? engineStatus.active_task : null,
      data_dir: {
        active: activeDataDir,
        default: defaultDataDir,
        config: config && config.dataDir ? config.dataDir : null,
        saved: savedDataDir,
        restart_required: savedDataDir !== null && savedDataDir !== activeDataDir,
      },
      settings_file: file,
    };
  }

  async function testApiKey(token) {
    if (typeof token !== 'string' || token.trim() === '') throw new SettingsError('invalid_api_key', 'API Key is required');
    const value = token.trim();
    if (!API_KEY_RE.test(value)) throw new SettingsError('invalid_api_key', 'API Key must be 64 hexadecimal characters');
    try {
      await client.validateApiKey(value.toLowerCase());
    } catch (error) {
      throw new SettingsError('key_test_failed', 'Markji rejected the API Key: ' + (error && error.message ? error.message : String(error)));
    }
    return { ok: true, tested: true };
  }

  async function setKey(token) {
    if (typeof token !== 'string' || token.trim() === '') throw new SettingsError('invalid_api_key', 'API Key is required');
    const value = token.trim().toLowerCase();
    if (!API_KEY_RE.test(value)) throw new SettingsError('invalid_api_key', 'API Key must be 64 hexadecimal characters');
    await testApiKey(value);
    let cipher;
    try {
      cipher = await secretBox.encrypt(value);
    } catch (error) {
      throw new SettingsError('secret_unavailable', 'could not encrypt the API Key: ' + (error && error.message ? error.message : String(error)));
    }
    try {
      await store.setSecret('api_key', cipher);
    } catch (error) {
      throw new SettingsError('cache_write_failed', 'could not store the encrypted API Key: ' + (error && error.message ? error.message : String(error)));
    }
    setApiKey(value);
    keyError = null;
    try {
      for (const name of ['MAIMEMO_MARKJI_OPENAPI_TOKEN', 'MAIMEMO_OPENAPI_TOKEN']) {
        if (process.env && Object.prototype.hasOwnProperty.call(process.env, name)) delete process.env[name];
      }
    } catch { /* environment may be read-only */ }
    return { ok: true, ...keyInfo(), saved: true };
  }

  async function clearKey() {
    try {
      await store.deleteSecret('api_key');
    } catch (error) {
      throw new SettingsError('cache_write_failed', 'could not remove the API Key: ' + (error && error.message ? error.message : String(error)));
    }
    setApiKey('');
    return { ok: true, ...keyInfo() };
  }

  async function setDataDir(value) {
    const target = validateDataDir(value);
    const active = currentDataDir;
    if (target === active) return { ok: true, data_dir: target, restart_required: false, unchanged: true };
    if (engine && typeof engine.status === 'function') {
      const s = engine.status();
      if (s && s.active_task) throw new SettingsError('sync_busy', 'a sync task is running; wait for it to finish before moving cache.db');
    }
    try {
      if (existsSync(target)) {
        accessSync(target, fsConstants.W_OK);
        if (readdirSync(target).length > 0) {
          throw new SettingsError('target_not_empty', 'the target directory is not empty; choose an empty directory or move the files manually');
        }
      } else {
        mkdirSync(target, { recursive: true });
      }
    } catch (error) {
      if (error instanceof SettingsError) throw error;
      throw new SettingsError('data_dir_not_writable', 'dataDir is not writable: ' + (error && error.message ? error.message : String(error)));
    }
    // Flush debounced saves before copying the live database so the new directory
    // reflects the latest pending edits.
    if (store && typeof store.saveNow === 'function') {
      try {
        await store.saveNow();
      } catch (error) {
        throw new SettingsError('cache_write_failed', 'could not flush cache.db before moving it: ' + (error && error.message ? error.message : String(error)));
      }
    }
    const sourceCache = join(active, 'cache.db');
    try {
      copyIfExists(sourceCache, join(target, 'cache.db'));
      for (const suffix of ['-wal', '-shm', '-journal']) copyIfExists(sourceCache + suffix, join(target, 'cache.db' + suffix));
      copyIfExists(join(active, 'secret.key'), join(target, 'secret.key'));
    } catch (error) {
      if (error instanceof SettingsError) throw error;
      throw new SettingsError('migration_failed', 'could not copy cache.db: ' + (error && error.message ? error.message : String(error)));
    }
    const saved = readSettingsFile(file, log);
    saved.dataDir = target;
    writeSettingsFile(file, saved);
    log('info', 'cache directory change saved; restart DSH to use ' + target);
    return { ok: true, data_dir: target, restart_required: true };
  }

  return {
    file,
    status,
    testApiKey,
    setApiKey: setKey,
    clearApiKey: clearKey,
    setDataDir,
    /** internal: record a startup decryption failure for status */
    setKeyError(error) {
      keyError = error === null || error === undefined ? null : error.code || 'secret_error';
    },
  };
}

/**
 * Register the authenticated settings route on the Host. Returns a disposer.
 * This route is optional: without the connection service the tools still work.
 */
export function registerSettingsRoute(ctx, settings) {
  const handler = async (request) => {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== SETTINGS_ROUTE) return new Response('not found', { status: 404 });
    const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };
    try {
      if (request.method === 'GET') return new Response(JSON.stringify(await settings.status()), { status: 200, headers });
      if (request.method !== 'POST') return new Response(JSON.stringify({ ok: false, error: { code: 'method_not_allowed', message: 'method not allowed' } }), { status: 405, headers });
      let body;
      try { body = await request.json(); } catch { return new Response(JSON.stringify({ ok: false, error: { code: 'invalid_body', message: 'invalid JSON body' } }), { status: 400, headers }); }
      const action = body && typeof body === 'object' ? body.action : null;
      let result;
      if (action === 'testApiKey') result = await settings.testApiKey(body.token);
      else if (action === 'setApiKey') result = await settings.setApiKey(body.token);
      else if (action === 'clearApiKey') result = await settings.clearApiKey();
      else if (action === 'setDataDir') result = await settings.setDataDir(body.dataDir);
      else throw new SettingsError('unknown_action', 'unknown settings action');
      return new Response(JSON.stringify(result), { status: 200, headers });
    } catch (error) {
      const status = error instanceof SettingsError ? 400 : 500;
      return new Response(JSON.stringify({
        ok: false,
        error: { code: error && error.code ? error.code : 'settings_failed', message: error && error.message ? error.message : String(error) },
      }), { status, headers });
    }
  };
  const mount = (scope) => {
    const connection = scope && typeof scope.get === 'function' ? scope.get('connection') : null;
    if (!connection || !connection.fetch || typeof connection.fetch.register !== 'function') return null;
    return scope.effect(
      () => connection.fetch.register({ path: SETTINGS_ROUTE, methods: ['GET', 'POST'], requestBody: 'buffered', fetch: handler }),
      'dsh-markji-bridge: settings route',
    );
  };
  // The connection service may be mounted after this plugin. Register eagerly
  // when it exists; otherwise wait for it through the composition's inject
  // machinery instead of probing once at apply time.
  const immediate = mount(ctx);
  if (immediate !== null) return immediate;
  if (ctx && typeof ctx.inject === 'function') {
    let dispose = null;
    ctx.inject(['connection'], (scope) => {
      if (typeof dispose === 'function') dispose();
      dispose = mount(scope);
    });
    return () => {
      if (typeof dispose === 'function') dispose();
      dispose = null;
    };
  }
  return null;
}
