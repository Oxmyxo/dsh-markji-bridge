/**
 * dsh-markji-bridge - Host plugin entry.
 *
 * Wire-up:
 *   rate limiter  client-side sliding windows for the provider quotas
 *   client        Markji OpenAPI HTTP client (lib/api.js)
 *   store         one SQLite cache.db holding the index and card content (lib/store.js)
 *   engine        pull / merge / push state machine and idle auto-sync (lib/sync.js)
 *   tools         17 markji_* agent tools (lib/tools.js), incl. raw Markji syntax
 *                 help and validation, media preflight, plain-text search,
 *                 background sync, archive and failure recovery
 *
 * Everything lives inside one ctx.effect: the effect registers the tools and
 * starts the engine, and its cleanup disposes the tools and stops the engine
 * (best effort, including a cache flush). apply() returns that disposer
 * synchronously; the engine start itself is not awaited, because the first tool
 * call awaits engine.ready() instead.
 *
 * Contract: DESIGN.md, sections "Config" and "lib/tools.js + index.js".
 */
import { copyFileSync, existsSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createLimiter } from './lib/rate-limit.js';
import { createClient } from './lib/api.js';
import { createStore } from './lib/store.js';
import { createEngine } from './lib/sync.js';
import { registerTools, TOOL_NAMES } from './lib/tools.js';

/** Host services this plugin needs before apply() runs. */
export const inject = ['tools'];

/** Documented config defaults (DESIGN.md "Config"). */
export const CONFIG_DEFAULTS = Object.freeze({
  enabled: true,
  apiKey: '',
  baseUrl: 'https://open.maimemo.com/open',
  dataDir: '',
  grammarVersion: 3,
  requestTimeoutMs: 20000,
  maxRetries: 3,
  pageSize: 100,
  pullTtlMs: 600000,
  autoSync: true,
  idleCheckMs: 30000,
  idleQuietMs: 120000,
  autoPullMs: 900000,
  retryBackoffMs: 300000,
  maxOutputChars: 20000,
});

const FIVE_MINUTES_MS = 300000;
const DAY_MS = 86400000;

function clampInt(value, min, max, fallback) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value === undefined || value === null ? '' : value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function readFlag(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  return fallback;
}

/** Default data directory: <homedir>/.dsh/dsh-markji-bridge (all platforms). */
export function defaultDataDir() {
  return join(homedir(), '.dsh', 'dsh-markji-bridge');
}

/** Legacy data directory used by earlier local builds, read once to migrate a cache. */
export function legacyDataDir() {
  return join(homedir(), '.dsh', 'markji-bridge');
}

/** Data directory: config dataDir when set, else the default. */
export function resolveDataDir(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text !== '') return text;
  return defaultDataDir();
}

/**
 * Copy a legacy cache into the default directory. Earlier local builds used
 * <homedir>/.dsh/markji-bridge; without this migration a cache written there
 * would be ignored and rebuilt from the API. It runs only when the target has
 * no cache.db yet and the legacy
 * directory has one. The legacy file is copied, never moved, so downgrading
 * still works. Any failure is logged and startup continues with a fresh cache.
 */
export function migrateLegacyCache(legacyDir, targetDir, log) {
  try {
    if (typeof legacyDir !== 'string' || legacyDir.trim() === '') return false;
    if (typeof targetDir !== 'string' || targetDir.trim() === '') return false;
    const source = join(legacyDir, 'cache.db');
    const target = join(targetDir, 'cache.db');
    if (!existsSync(source) || existsSync(target)) return false;
    mkdirSync(targetDir, { recursive: true });
    // Copy to a process-private temp name first, then rename into place, so a
    // second process starting at the same moment never reads a half-copied
    // database. If the other process won the race the target already exists and
    // this copy is discarded (the existing target is authoritative).
    const temp = target + '.migrating-' + process.pid;
    try {
      copyFileSync(source, temp);
      try {
        renameSync(temp, target);
      } catch (error) {
        if (existsSync(target)) return false;
        throw error;
      }
    } finally {
      if (existsSync(temp)) {
        try {
          unlinkSync(temp);
        } catch {
          /* best effort */
        }
      }
    }
    for (const suffix of ['-wal', '-shm', '-journal']) {
      if (existsSync(source + suffix)) copyFileSync(source + suffix, target + suffix);
    }
    if (typeof log === 'function') log('info', 'migrated legacy cache ' + source + ' -> ' + target);
    return true;
  } catch (error) {
    if (typeof log === 'function') {
      log('warn', 'legacy cache migration skipped: ' + errorMessage(error));
    }
    return false;
  }
}

/**
 * Normalize the row config into the camelCase object passed to the client,
 * store, engine and tools. Invalid numbers are clamped and unknown keys are
 * ignored; an empty apiKey falls back to MAIMEMO_MARKJI_OPENAPI_TOKEN
 * (legacy: MAIMEMO_OPENAPI_TOKEN).
 */
export function readConfig(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const rawBaseUrl = typeof source.baseUrl === 'string' ? source.baseUrl.trim() : '';
  const baseUrl = (rawBaseUrl === '' ? CONFIG_DEFAULTS.baseUrl : rawBaseUrl).replace(/\/+$/, '');
  const rawApiKey = typeof source.apiKey === 'string' ? source.apiKey.trim() : '';
  const envToken = process.env.MAIMEMO_MARKJI_OPENAPI_TOKEN;
  const legacyEnvToken = process.env.MAIMEMO_OPENAPI_TOKEN;
  const envApiKey =
    typeof envToken === 'string' && envToken.trim() !== ''
      ? envToken.trim()
      : typeof legacyEnvToken === 'string'
        ? legacyEnvToken.trim()
        : '';
  return {
    enabled: readFlag(source.enabled, CONFIG_DEFAULTS.enabled),
    apiKey: rawApiKey !== '' ? rawApiKey : envApiKey,
    baseUrl,
    dataDir: resolveDataDir(source.dataDir),
    grammarVersion: clampInt(source.grammarVersion, 1, 99, CONFIG_DEFAULTS.grammarVersion),
    requestTimeoutMs: clampInt(source.requestTimeoutMs, 1000, 600000, CONFIG_DEFAULTS.requestTimeoutMs),
    maxRetries: clampInt(source.maxRetries, 0, 10, CONFIG_DEFAULTS.maxRetries),
    pageSize: clampInt(source.pageSize, 1, 1000, CONFIG_DEFAULTS.pageSize),
    pullTtlMs: clampInt(source.pullTtlMs, 0, 7 * DAY_MS, CONFIG_DEFAULTS.pullTtlMs),
    autoSync: readFlag(source.autoSync, CONFIG_DEFAULTS.autoSync),
    idleCheckMs: clampInt(source.idleCheckMs, 1000, 3600000, CONFIG_DEFAULTS.idleCheckMs),
    idleQuietMs: clampInt(source.idleQuietMs, 0, DAY_MS, CONFIG_DEFAULTS.idleQuietMs),
    autoPullMs: clampInt(source.autoPullMs, 1000, 30 * DAY_MS, CONFIG_DEFAULTS.autoPullMs),
    retryBackoffMs: clampInt(source.retryBackoffMs, 0, DAY_MS, CONFIG_DEFAULTS.retryBackoffMs),
    maxOutputChars: clampInt(source.maxOutputChars, 2000, 200000, CONFIG_DEFAULTS.maxOutputChars),
  };
}

function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/**
 * Logger with the documented "[dsh-markji-bridge] <level> <message>" prefix. The
 * API token is redacted as a last line of defense; it is never logged by code.
 */
function createLogger(apiKey) {
  const secret = typeof apiKey === 'string' ? apiKey.trim() : '';
  const redact = (text) => (secret.length >= 8 ? text.split(secret).join('<redacted>') : text);
  return function log(level, message) {
    try {
      const text = typeof message === 'string' ? message : String(message);
      const method = typeof console[level] === 'function' ? console[level] : console.log;
      method.call(console, '[dsh-markji-bridge] ' + String(level) + ' ' + redact(text));
    } catch (error) {
      /* logging is best effort */
    }
  };
}

/**
 * Cordis plugin entry point.
 *
 * @param ctx - live Cordis plugin context (inject: tools).
 * @param rawConfig - plain object from cordis.patch.yml.
 * @returns a disposer when enabled:false; otherwise ctx.effect registers the cleanup.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig);
  const log = createLogger(config.apiKey);
  if (config.enabled === false) {
    log('info', 'disabled by config (enabled:false); registering nothing');
    return undefined;
  }
  if (ctx === null || ctx === undefined || typeof ctx.effect !== 'function') {
    throw new Error('dsh-markji-bridge apply(ctx, config) requires a live Cordis plugin context');
  }
  if (ctx.tools === null || ctx.tools === undefined || typeof ctx.tools.register !== 'function') {
    throw new Error('dsh-markji-bridge requires the tools service (export const inject = [\'tools\'])');
  }

  log(
    'info',
    'starting dsh-markji-bridge (data dir: ' +
      config.dataDir +
      ', base url: ' +
      config.baseUrl +
      ', token: ' +
      (config.apiKey === '' ? 'missing' : 'configured') +
      ')',
  );

  return ctx.effect(() => {
    const limiter = createLimiter({ log });
    const client = createClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      limiter,
      log,
    });
    // One-time migration path for a cache written by an earlier local build under
    // the old directory name. An explicit dataDir is never touched.
    if (config.dataDir === defaultDataDir()) {
      migrateLegacyCache(legacyDataDir(), config.dataDir, log);
    }
    const store = createStore({ dataDir: config.dataDir, log });
    const engine = createEngine({ client, store, config, log });
    let disposeTools = null;
    try {
      // The client is passed in addition to the documented three dependencies so
      // markji_file can upload/query through the same rate-limited client.
      disposeTools = registerTools(ctx, { engine, config, log, client });
    } catch (error) {
      try {
        if (engine !== null && typeof engine.stop === 'function') void engine.stop();
      } catch (ignored) {
        /* startup failure already being reported */
      }
      log('error', 'tool registration failed: ' + errorMessage(error));
      throw error;
    }

    // Do not block apply(): the first tool call awaits engine.ready().
    void Promise.resolve()
      .then(() => engine.start())
      .catch((error) => log('error', 'engine start failed: ' + errorMessage(error)));

    if (config.apiKey === '') {
      log('warn', 'no Markji token configured; set MAIMEMO_MARKJI_OPENAPI_TOKEN or apiKey in the plugin config. cached reads still work and cloud calls fail with not_configured');
    }
    log(
      'info',
      'ready: ' + TOOL_NAMES.length + ' markji tools, auto-sync ' +
        (config.autoSync ? 'on' : 'off') +
        ', idle check ' +
        String(config.idleCheckMs) +
        'ms, quiet ' +
        String(config.idleQuietMs) +
        'ms',
    );

    let closed = false;
    return async function cleanup() {
      if (closed) return;
      closed = true;
      if (typeof disposeTools === 'function') {
        try {
          disposeTools();
        } catch (error) {
          log('warn', 'tool teardown failed: ' + errorMessage(error));
        }
      }
      try {
        await engine.stop();
      } catch (error) {
        log('warn', 'engine stop failed: ' + errorMessage(error));
      }
      try {
        if (store !== null && typeof store.close === 'function') await store.close();
      } catch (error) {
        log('warn', 'store close failed: ' + errorMessage(error));
      }
      log('info', 'disposed');
    };
  }, 'dsh-markji-bridge');
}
