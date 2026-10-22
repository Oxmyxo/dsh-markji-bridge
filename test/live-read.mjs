// dsh-markji-bridge: live READ-ONLY smoke check against the real Markji OpenAPI.
// Sends only GET requests: listFolders, listDecksPage, listChapters (with_cards),
// getCard, plus one intentionally invalid getCard to prove provider error mapping.
// No write endpoint is ever called.
//
// Usage (token never printed):
//   $env:MAIMEMO_MARKJI_OPENAPI_TOKEN = "<token>"; node test/live-read.mjs
//   node test/live-read.mjs <token>

import { createClient, MarkjiError } from "../lib/api.js";
import { createLimiter } from "../lib/rate-limit.js";

// The node test runner treats every file under test/ as a test file. When it
// executes this script (NODE_TEST_CONTEXT is set in test child processes), skip
// the live network probe; run the script directly for the real check.
if (process.env.NODE_TEST_CONTEXT) {
  console.log("live-read.mjs: skipped under the node test runner (run it directly for the live check)");
  process.exit(0);
}

const token = process.argv[2] || process.env.MAIMEMO_MARKJI_OPENAPI_TOKEN || process.env.MAIMEMO_OPENAPI_TOKEN || "";
if (!token || token.trim() === "") {
  console.error("live-read: missing token. Pass it as argv[2] or MAIMEMO_MARKJI_OPENAPI_TOKEN.");
  process.exit(2);
}

const BASE_URL = process.env.MARKJI_BASE_URL || "https://open.maimemo.com/open";
const started = Date.now();
const timings = [];

function redact(text) {
  return String(text).split(token).join("<redacted>");
}

function logLine(...parts) {
  console.log(redact(parts.join(" ")));
}

function shapeOf(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return `array(${value.length})`;
  if (typeof value === "object") return `object{ ${Object.keys(value).join(", ")} }`;
  return `${typeof value} ${JSON.stringify(value)}`;
}

function preview(value, max = 1000) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (err) {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > max ? `${text.slice(0, max)}... <truncated>` : text;
}

async function timed(label, fn) {
  const t0 = Date.now();
  try {
    const value = await fn();
    timings.push({ label, ms: Date.now() - t0, ok: true });
    return value;
  } catch (err) {
    timings.push({ label, ms: Date.now() - t0, ok: false });
    throw err;
  }
}

// Prefer the smallest deck that actually has cards, so the probe pulls little data.
function chooseSmallDeck(decks) {
  let best = null;
  for (const deck of decks) {
    const count = Number(deck && deck.card_count);
    if (!Number.isFinite(count) || count <= 0) continue;
    if (!best || count < best.score) best = { deck, score: count };
  }
  return best ? best.deck : null;
}

const log = (level, message) => {
  if (level === "debug") return; // keep the probe output compact
  console.error(redact(`[markji live-read] ${level} ${message}`));
};

const limiter = createLimiter({ log: (level, message) => log(level, message) });
const client = createClient({
  apiKey: token,
  baseUrl: BASE_URL,
  timeoutMs: 20000,
  maxRetries: 2,
  limiter,
  log,
});

logLine("== dsh-markji-bridge live read-only check ==");
logLine(`baseUrl: ${BASE_URL}`);
logLine(`configured: ${client.configured}`);
logLine("");

try {
  // 1. folders
  const folders = await timed("listFolders", () => client.listFolders());
  logLine(`[1/5] listFolders -> ${shapeOf(folders)}`);
  logLine(`      folder[0]: ${shapeOf(folders[0])}`);
  if (folders[0]) {
    logLine(`      folder[0].items[0]: ${shapeOf(folders[0].items && folders[0].items[0])}`);
  }
  logLine("");

  // 2. decks: first page is enough to see the envelope; keep paging only while no
  // deck with cards has been seen.
  let decks = [];
  let total = 0;
  let pages = 0;
  for (let offset = 0; offset < 100; ) {
    const page = await timed(`listDecksPage(offset=${offset})`, () => client.listDecksPage({ offset, limit: 20 }));
    pages += 1;
    total = page.total;
    decks = decks.concat(page.decks);
    if (chooseSmallDeck(decks)) break;
    if (page.decks.length === 0 || decks.length >= total) break;
    offset += page.decks.length;
  }
  logLine(`[2/5] listDecksPage -> decks array(${decks.length}) over ${pages} page(s), total ${total}`);
  const deck = decks[0];
  if (!deck) throw new Error("live API returned no decks; cannot continue");
  logLine(`      deck[0] keys: ${Object.keys(deck).join(", ")}`);
  logLine(`      deck[0]: ${preview({
    id: deck.id,
    name: deck.name,
    card_count: deck.card_count,
    chapter_count: deck.chapter_count,
    revision: deck.revision,
    updated_time: deck.updated_time,
  })}`);
  const small = chooseSmallDeck(decks);
  if (!small) throw new Error("live API returned no deck with cards; cannot continue");
  logLine(`      smallest deck with cards: id=${small.id} card_count=${small.card_count} chapter_count=${small.chapter_count}`);
  logLine("");

  // 3. chapters with cards for the small deck
  const chapters = await timed("listChapters", () => client.listChapters(small.id, { with_cards: true }));
  logLine(`[3/5] listChapters(with_cards) -> chapters ${shapeOf(chapters.chapters)}, cards ${shapeOf(chapters.cards)}`);
  logLine(`      chapterset: ${chapters.chapterset === undefined ? "(absent)" : shapeOf(chapters.chapterset)}`);
  const chapter = chapters.chapters[0];
  if (!chapter) throw new Error("live API returned no chapters for the chosen deck");
  logLine(`      chapter[0] keys: ${Object.keys(chapter).join(", ")}`);
  logLine(`      chapter[0]: ${preview({
    id: chapter.id,
    name: chapter.name,
    revision: chapter.revision,
    order: chapter.order,
    card_ids_length: Array.isArray(chapter.card_ids) ? chapter.card_ids.length : chapter.card_ids,
  })}`);
  const card = chapters.cards[0];
  if (!card) throw new Error("live API returned no cards for the chosen deck");
  logLine(`      card[0] keys: ${Object.keys(card).join(", ")}`);
  logLine(`      card[0]: ${preview({
    id: card.id,
    content: typeof card.content === "string" ? card.content.slice(0, 60) : card.content,
    content_type: card.content_type,
    content_type_type: typeof card.content_type,
    grammar_version: card.grammar_version,
    revision: card.revision,
    status: card.status,
    updated_time: card.updated_time,
  })}`);
  logLine(`      card has chapter_id field: ${Object.prototype.hasOwnProperty.call(card, "chapter_id")}`);
  logLine("");

  // 4. single card
  const one = await timed("getCard", () => client.getCard(small.id, card.id));
  logLine(`[4/5] getCard -> ${shapeOf(one)}`);
  logLine(`      same id: ${one.id === card.id}; grammar_version: ${one.grammar_version}; content_type: ${one.content_type}`);
  logLine("");

  // 5. read-only error envelope check (invalid id, still a GET)
  logLine("[5/5] getCard with an invalid deck id -> expecting a provider error envelope mapping");
  try {
    await client.getCard("dummy_invalid_id_for_probe", "dummy_invalid_id_for_probe");
    logLine("      ERROR: invalid id unexpectedly succeeded; error mapping NOT proven");
    process.exitCode = 1;
  } catch (err) {
    if (!(err instanceof MarkjiError)) throw err;
    logLine(`      MarkjiError code=${err.code} status=${err.status} retriable=${err.retriable} message="${err.message}"`);
    const expected = err.code === "common_invalid_res_id" || err.status === 400;
    logLine(`      envelope/error mapping verified: ${expected ? "yes" : "NO (unexpected code)"}`);
    if (!expected) process.exitCode = 1;
  }
  logLine("");

  logLine("== timing ==");
  for (const entry of timings) logLine(`  ${entry.ok ? "ok  " : "FAIL"} ${entry.label}: ${entry.ms}ms`);
  logLine(`  total: ${Date.now() - started}ms`);
  logLine("");
  logLine("== client stats ==");
  logLine(preview(client.stats()));
  logLine("");
  logLine("RESULT: live read-only check passed");
} catch (err) {
  logLine("");
  logLine("RESULT: live read-only check FAILED");
  if (err instanceof MarkjiError) {
    logLine(`MarkjiError code=${err.code} status=${err.status} retriable=${err.retriable} message="${err.message}"`);
    logLine(`details: ${preview(err.details)}`);
  } else {
    logLine(redact(err && err.stack ? err.stack : String(err)));
  }
  process.exitCode = 1;
}
