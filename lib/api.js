// dsh-markji-bridge: Markji (墨墨记忆卡) OpenAPI HTTP client.
// Node builtins only. fetch / limiter / clock are injectable so tests never touch
// the network and never sleep for real.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import { createLimiter } from "./rate-limit.js";

const DEFAULT_BASE_URL = "https://open.maimemo.com/open";
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_RETRIES = 3;
const MAX_RETRIES_CAP = 10;
const MAX_LIST_PAGES = 100;
const SNIPPET_CHARS = 500;
const JSON_PARSE_FAILED = Symbol("markji-json-parse-failed");

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  mp3: "audio/mpeg",
  wav: "audio/wav",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  mp4: "video/mp4",
};

export class MarkjiError extends Error {
  constructor({ code = "unknown", status = null, message = "", details = null, retriable = false } = {}) {
    super(message || code);
    this.name = "MarkjiError";
    this.code = String(code);
    this.status = status === null || status === undefined ? null : Number(status);
    this.retriable = Boolean(retriable);
    this.details = details === undefined ? null : details;
  }
}

function notConfiguredError() {
  return new MarkjiError({
    code: "not_configured",
    message: "Markji API Key is not configured; open Plugins -> dsh-markji-bridge and save it on the plugin page.",
    retriable: false,
  });
}

function snippet(text) {
  const raw = typeof text === "string" ? text : "";
  return raw.length > SNIPPET_CHARS ? raw.slice(0, SNIPPET_CHARS) : raw;
}

function badResponseError(text, reason) {
  return new MarkjiError({
    code: "bad_response",
    message: `Markji API returned an unexpected response (${reason})`,
    details: { reason, body: snippet(text) },
    retriable: false,
  });
}

function tryParseJson(text) {
  if (typeof text !== "string" || text.length === 0) return JSON_PARSE_FAILED;
  try {
    return JSON.parse(text);
  } catch {
    return JSON_PARSE_FAILED;
  }
}

function isRetriableStatus(status) {
  return status === 408 || status === 429 || (status >= 500 && status <= 599);
}

// Read code/message out of the provider error envelope when present.
function providerErrorFields(parsed, text) {
  const fields = { code: null, message: null, details: null };
  if (parsed && typeof parsed === "object" && Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const first = parsed.errors[0] && typeof parsed.errors[0] === "object" ? parsed.errors[0] : {};
    if (typeof first.code === "string" && first.code) fields.code = first.code;
    if (typeof first.msg === "string" && first.msg) fields.message = first.msg;
    else if (typeof first.message === "string" && first.message) fields.message = first.message;
    fields.details = parsed.errors;
  }
  if (fields.details === null) {
    const body = snippet(text);
    fields.details = body.length > 0 ? { body } : null;
  }
  return fields;
}

function httpError(status, parsed, text, res) {
  const fields = providerErrorFields(parsed, text);
  let message = fields.message;
  if (!message) {
    const statusText = res && typeof res.statusText === "string" ? res.statusText : "";
    message = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
  }
  return new MarkjiError({
    code: fields.code || `http_${status}`,
    status,
    message,
    details: fields.details,
    retriable: isRetriableStatus(status),
  });
}

function envelopeError(parsed, status, text) {
  const fields = providerErrorFields(parsed, text);
  return new MarkjiError({
    code: fields.code || "invalid_response",
    status,
    message: fields.message || "Markji API rejected the request",
    details: fields.details,
    retriable: false,
  });
}

function transportError(err) {
  const name = err && err.name ? String(err.name) : "";
  const message = err && err.message ? String(err.message) : "network request failed";
  if (name === "TimeoutError" || name === "AbortError") {
    return new MarkjiError({
      code: "timeout",
      message: "Markji API request timed out",
      details: { name, message },
      retriable: true,
    });
  }
  return new MarkjiError({
    code: "network_error",
    message: `Markji API request failed: ${message}`,
    details: { name, message },
    retriable: true,
  });
}

function retryAfterMs(res) {
  const headers = res && res.headers;
  if (!headers || typeof headers.get !== "function") return null;
  const raw = headers.get("retry-after");
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(raw);
  return Number.isFinite(dateMs) ? Math.max(0, dateMs - Date.now()) : null;
}

function mimeForFilename(filename) {
  const ext = extname(typeof filename === "string" ? filename : "").replace(/^\./, "").toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function asPositiveInt(value, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function createClient({
  apiKey = "",
  apiKeyReady = null,
  baseUrl = DEFAULT_BASE_URL,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxRetries = DEFAULT_MAX_RETRIES,
  limiter,
  fetchImpl,
  log,
  // Optional test hooks (not part of the required contract): deterministic sleep,
  // jitter source and clock for retry/stat assertions.
  sleep,
  random,
  now,
} = {}) {
  let token = typeof apiKey === "string" ? apiKey.trim() : "";
  let configured = token.length > 0;
  const root = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  const requestTimeoutMs = asPositiveInt(timeoutMs, DEFAULT_TIMEOUT_MS, 1, 2147483647);
  const retries = asPositiveInt(maxRetries, DEFAULT_MAX_RETRIES, 0, MAX_RETRIES_CAP);
  const clock = typeof now === "function" ? now : Date.now;
  const sleepFn = typeof sleep === "function" ? sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const randomFn = typeof random === "function" ? random : Math.random;
  const logFn = typeof log === "function" ? log : () => {};
  const fetchFn =
    typeof fetchImpl === "function" ? fetchImpl : (url, init) => globalThis.fetch(url, init);
  const rateLimiter =
    limiter && typeof limiter.acquire === "function" ? limiter : createLimiter({ now: clock, log: logFn });

  const stats = { requests: 0, retries: 0, lastStatus: null, lastErrorAt: null };
  const readyPromise = apiKeyReady !== null && typeof apiKeyReady === "object" && typeof apiKeyReady.then === "function" ? apiKeyReady : null;

  function ensureConfigured() {
    if (!configured) throw notConfiguredError();
  }

  /** Replace the in-memory bearer token; the settings host calls this after a successful test. */
  function setApiKey(next) {
    token = typeof next === "string" ? next.trim() : "";
    configured = token.length > 0;
    return configured;
  }

  /** Probe a candidate token without changing the active one. Returns true or throws the provider error. */
  async function validateApiKey(candidate) {
    const previous = token;
    setApiKey(candidate);
    try {
      await listDecksPage({ limit: 1 });
      return true;
    } finally {
      token = previous;
      configured = previous.length > 0;
    }
  }

  function buildUrl(path, query) {
    let url = `${root}/api/v1${path}`;
    const params = new URLSearchParams();
    if (query && typeof query === "object") {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        params.append(key, typeof value === "boolean" ? (value ? "true" : "false") : String(value));
      }
    }
    const qs = params.toString();
    return qs ? `${url}?${qs}` : url;
  }

  function backoffDelay(attempt, retryAfter) {
    const base = 500 * 2 ** attempt;
    const jitter = Math.floor(base * 0.25 * randomFn());
    let delay = base + jitter;
    if (Number.isFinite(retryAfter) && retryAfter > delay) delay = retryAfter;
    return delay;
  }

  // One HTTP attempt loop: acquire a token, fetch, unwrap, retry retriable failures.
  async function execute(method, path, { query, json, form } = {}) {
    if (readyPromise !== null) {
      try {
        await readyPromise;
      } catch {
        /* the missing-key path below reports the failure */
      }
    }
    ensureConfigured();
    const url = buildUrl(path, query);
    const maxAttempts = retries + 1;
    let lastError = null;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await rateLimiter.acquire();

      const headers = {
        authorization: `Bearer ${token}`,
        accept: "application/json",
      };
      const init = { method, headers };
      if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
        init.signal = AbortSignal.timeout(requestTimeoutMs);
      }
      if (json !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(json);
      } else if (form !== undefined) {
        // FormData: fetch supplies the multipart content-type and boundary.
        init.body = form;
      }

      let res;
      let text;
      stats.requests += 1;
      try {
        res = await fetchFn(url, init);
        if (res && res.status !== undefined && res.status !== null) {
          const status = Number(res.status);
          if (Number.isFinite(status)) stats.lastStatus = status;
        }
        text = res && typeof res.text === "function" ? await res.text() : "";
      } catch (err) {
        stats.lastErrorAt = clock();
        const mapped = transportError(err);
        lastError = mapped;
        if (attempt < retries) {
          stats.retries += 1;
          const delay = backoffDelay(attempt, null);
          logFn("warn", `markji api ${method} ${path} attempt ${attempt + 1} failed (${mapped.code}), retrying in ${Math.round(delay)}ms`);
          await sleepFn(delay);
          continue;
        }
        throw mapped;
      }

      const status = res && res.status !== undefined ? Number(res.status) : 0;
      const ok = res && typeof res.ok === "boolean" ? res.ok : status >= 200 && status < 300;
      const parsed = tryParseJson(text);

      if (!ok) {
        stats.lastErrorAt = clock();
        const error = httpError(status, parsed, text, res);
        lastError = error;
        if (isRetriableStatus(status) && attempt < retries) {
          stats.retries += 1;
          const delay = backoffDelay(attempt, retryAfterMs(res));
          logFn("warn", `markji api ${method} ${path} attempt ${attempt + 1} failed (HTTP ${status}), retrying in ${Math.round(delay)}ms`);
          await sleepFn(delay);
          continue;
        }
        throw error;
      }

      if (parsed === JSON_PARSE_FAILED) throw badResponseError(text, "invalid json");
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw badResponseError(text, "unexpected body");
      }
      if (parsed.success !== true) {
        stats.lastErrorAt = clock();
        throw envelopeError(parsed, status, text);
      }
      if (!Object.prototype.hasOwnProperty.call(parsed, "data") || parsed.data === undefined) {
        throw badResponseError(text, "missing data");
      }
      return parsed.data;
    }

    throw lastError || new MarkjiError({ code: "unknown", message: "Markji API request failed", retriable: true });
  }

  function encoded(value) {
    return encodeURIComponent(String(value));
  }

  // The provider resolves deck/chapter ids from the URL path only. Repeating the
  // path ids inside the JSON body makes it parse them as raw Mongo ObjectIds, so
  // the public OpenAPI ids ("mkjd_…"/"mkjch_…") are rejected with
  // "deck not a valid ObjectId" (verified live 2026-10-22). Send the body without
  // the path ids, and fall back to the full body only if the provider explicitly
  // reports one of them as a missing required property.
  function bodyWithoutPathIds(body, pathIds) {
    const trimmed = { ...body };
    for (const key of pathIds) delete trimmed[key];
    return trimmed;
  }

  function missingRequiredBodyProperty(error, pathIds) {
    if (!error || error.code !== "common_invalid_param") return false;
    const details = Array.isArray(error.details) ? error.details : [];
    const text = details
      .map((entry) => (entry && typeof entry === "object"
        ? `${entry.info || ""} ${entry.msg || ""} ${entry.message || ""}`
        : ""))
      .join(" ")
      .toLowerCase();
    return pathIds.some((key) => text.includes(`required property '${key.toLowerCase()}'`));
  }

  async function postWrite(path, body, pathIds) {
    try {
      return await execute("POST", path, { json: bodyWithoutPathIds(body, pathIds) });
    } catch (error) {
      if (!missingRequiredBodyProperty(error, pathIds)) throw error;
      return execute("POST", path, { json: body });
    }
  }

  async function listFolders() {
    const data = await execute("GET", "/markji/decks/folders");
    return Array.isArray(data.folders) ? data.folders : [];
  }

  async function listDecksPage({ offset, limit, folder_id } = {}) {
    const data = await execute("GET", "/markji/decks", { query: { offset, limit, folder_id } });
    const decks = Array.isArray(data.decks) ? data.decks : [];
    const total = Number(data.total);
    return { decks, total: Number.isFinite(total) ? total : decks.length };
  }

  async function listAllDecks({ pageSize } = {}) {
    ensureConfigured();
    const limit = asPositiveInt(pageSize, 100, 1, 500);
    const decks = [];
    let offset = 0;
    let total = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const result = await listDecksPage({ offset, limit });
      const batch = result.decks;
      decks.push(...batch);
      if (Number.isFinite(result.total)) total = result.total;
      if (batch.length === 0) break;
      if (total !== null && decks.length >= total) break;
      if (batch.length < limit && total === null) break;
      offset += batch.length;
    }
    return decks;
  }

  async function getDeck(deck, { with_root } = {}) {
    const data = await execute("GET", `/markji/decks/${encoded(deck)}`, { query: { with_root } });
    return data.deck;
  }

  async function listChapters(deck, { with_cards, updated_time } = {}) {
    const data = await execute("GET", `/markji/decks/${encoded(deck)}/chapters`, {
      query: { with_cards, updated_time },
    });
    return {
      chapterset: data.chapterset,
      chapters: Array.isArray(data.chapters) ? data.chapters : [],
      cards: Array.isArray(data.cards) ? data.cards : [],
    };
  }

  async function getChapter(deck, chapter, { with_cards } = {}) {
    const data = await execute("GET", `/markji/decks/${encoded(deck)}/chapters/${encoded(chapter)}`, {
      query: { with_cards },
    });
    return {
      chapterset: data.chapterset,
      chapter: data.chapter,
      cards: Array.isArray(data.cards) ? data.cards : [],
    };
  }

  async function createChapter({ deck, name, order } = {}) {
    const body = { deck, name };
    if (order !== undefined) body.order = order;
    const data = await postWrite(`/markji/decks/${encoded(deck)}/chapters`, body, ["deck"]);
    return { chapter: data.chapter, chapterset: data.chapterset };
  }

  async function updateChapter({ deck, chapter, name, revision } = {}) {
    const body = { deck, chapter, name };
    if (revision !== undefined) body.revision = revision;
    const data = await postWrite(`/markji/decks/${encoded(deck)}/chapters/${encoded(chapter)}`, body, ["deck", "chapter"]);
    return data.chapter;
  }

  async function sortChapters({ deck, chapter_ids, revision } = {}) {
    const body = { deck, chapter_ids };
    if (revision !== undefined) body.revision = revision;
    const data = await postWrite(`/markji/decks/${encoded(deck)}/chapters/sort`, body, ["deck"]);
    return data.chapterset;
  }

  async function getCard(deck, card) {
    const data = await execute("GET", `/markji/decks/${encoded(deck)}/cards/${encoded(card)}`);
    return data.card;
  }

  async function createCard({ deck, chapter, card, order } = {}) {
    const body = { deck, chapter, card };
    if (order !== undefined) body.order = order;
    const data = await postWrite(`/markji/decks/${encoded(deck)}/chapters/${encoded(chapter)}/cards`, body, ["deck", "chapter"]);
    return { card: data.card, chapter: data.chapter };
  }

  async function updateCard({ deck_id, card_id, card } = {}) {
    const data = await postWrite(`/markji/decks/${encoded(deck_id)}/cards/${encoded(card_id)}`, { deck_id, card_id, card }, ["deck_id", "card_id"]);
    return data.card;
  }

  async function moveCards({ deck, chapter, card_ids, to_chapter_id, order } = {}) {
    const body = { deck, chapter, card_ids, to_chapter_id };
    if (order !== undefined) body.order = order;
    const data = await postWrite(`/markji/decks/${encoded(deck)}/chapters/${encoded(chapter)}/cards/move`, body, ["deck", "chapter"]);
    return { new_chapter: data.new_chapter, old_chapter: data.old_chapter };
  }

  async function uploadFile(input = {}) {
    ensureConfigured();
    let bytes;
    let filename;
    let mime;
    if (input && typeof input.path === "string" && input.path.length > 0) {
      bytes = await readFile(input.path);
      filename = basename(input.path);
      mime = input.mime || mimeForFilename(filename);
    } else if (input && input.data !== undefined && input.data !== null) {
      bytes = input.data;
      filename = typeof input.filename === "string" && input.filename ? input.filename : "upload.bin";
      mime = input.mime || mimeForFilename(filename);
    } else {
      throw new MarkjiError({
        code: "invalid_argument",
        message: "uploadFile requires either { path } or { data, filename }",
        retriable: false,
      });
    }
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: mime }), filename);
    if (input.deck_id !== undefined && input.deck_id !== null && input.deck_id !== "") {
      form.append("deck_id", String(input.deck_id));
    }
    const data = await execute("POST", "/markji/files", { form });
    return data.file;
  }

  async function queryFiles({ ids, expires } = {}) {
    const body = { ids };
    if (expires !== undefined) body.expires = expires;
    const data = await execute("POST", "/markji/files/query", { json: body });
    return Array.isArray(data.files) ? data.files : [];
  }

  function snapshotStats() {
    ensureConfigured();
    return {
      requests: stats.requests,
      retries: stats.retries,
      lastStatus: stats.lastStatus,
      lastErrorAt: stats.lastErrorAt,
    };
  }

  return {
    get configured() {
      return configured;
    },
    setApiKey,
    validateApiKey,
    listFolders,
    listDecksPage,
    listAllDecks,
    getDeck,
    listChapters,
    getChapter,
    createChapter,
    updateChapter,
    sortChapters,
    getCard,
    createCard,
    updateCard,
    moveCards,
    uploadFile,
    queryFiles,
    stats: snapshotStats,
  };
}
