/**
 * markji_sync preflight: raw syntax validation plus media availability checks.
 *
 * Run: node --test "test/media-preflight.test.js"
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

function makeEngine(dir, mock, wrap) {
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
  const client = wrap ? wrap(baseClient) : baseClient;
  const store = createStore({ dataDir: dir, log: () => {}, clock: Date.now });
  const engine = createEngine({ client, store, config, log: () => {}, clock: Date.now });
  return { engine, store };
}

async function withFixture(name, options, run) {
  const dir = await mkdtemp(join(tmpdir(), 'markji-media-'));
  const mock = await startMockMarkji({ token: 'media-token' });
  let engine = null;
  let store = null;
  try {
    const deck = mock.newDeck(name, { chapters: ['普通'] });
    const chapter = mock.state.chapters[0];
    ({ engine, store } = makeEngine(dir, mock, options.wrap));
    await engine.ready();
    await engine.sync({ mode: 'pull', full: true });
    await run({ engine, store, mock, deck, chapter });
  } finally {
    if (engine) await engine.stop();
    if (store) await store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

function seedFile(mock, id) {
  mock.state.files.push({
    file: {
      id,
      url: mock.url + '/files/' + id,
      mime: 'image/png',
      size: 4,
      info: { filename: id + '.png' },
      expire_time: new Date(Date.now() + 86400000).toISOString(),
    },
    data: Buffer.from([1, 2, 3, 4]),
  });
}

test('pushes valid media and reports missing ids without writing them', async () => {
  await withFixture('媒体预检', {}, async ({ engine, mock, deck, chapter }) => {
    seedFile(mock, 'mkjf_present');
    const good = await engine.createCard({ deck: deck.id, chapter: chapter.id, content: '[Pic#ID/mkjf_present#]' });
    const missing = await engine.createCard({ deck: deck.id, chapter: chapter.id, content: '[Pic#ID/mkjf_missing#]' });
    const invalid = await engine.createCard({ deck: deck.id, chapter: chapter.id, content: '[X##bad]' });
    const report = await engine.push();
    assert.equal(report.cards_created, 1);
    assert.equal(mock.state.cards.length, 1);
    assert.equal(mock.state.cards[0].content, '[Pic#ID/mkjf_present#]');

    const missingError = report.errors.find((entry) => entry.id === missing.card_id);
    assert.ok(missingError, 'missing media is reported: ' + JSON.stringify(report.errors));
    assert.equal(missingError.code, 'media_unavailable');
    assert.match(missingError.message, /mkjf_missing/);

    const invalidError = report.errors.find((entry) => entry.id === invalid.card_id);
    assert.ok(invalidError, 'invalid syntax is reported: ' + JSON.stringify(report.errors));
    assert.equal(invalidError.code, 'invalid_card_content');

    const missingCard = await engine.getCard({ card: missing.card_id });
    assert.equal(missingCard.card.status, 'new');
    assert.equal(missingCard.card.last_error.code, 'media_unavailable');
    const invalidCard = await engine.getCard({ card: invalid.card_id });
    assert.equal(invalidCard.card.last_error.code, 'invalid_card_content');
    assert.equal(mock.state.cards.some((card) => card.content.includes('bad')), false);
  });
});

test('does not move a card whose content preflight failed', async () => {
  await withFixture('媒体移动预检', {}, async ({ engine, mock, deck, chapter }) => {
    const target = mock.newChapter(deck.id, '目标章节');
    const card = mock.newCard(deck.id, chapter.id, '原始内容');
    await engine.sync({ mode: 'pull', full: true });
    await engine.updateCard({ card: card.id, content: '[Pic#ID/mkjf_missing#]' });
    await engine.moveCards({ cards: [card.id], to_chapter: target.id });
    const report = await engine.push();
    const error = report.errors.find((entry) => entry.id === card.id);
    assert.ok(error, 'missing media is reported: ' + JSON.stringify(report.errors));
    assert.equal(error.code, 'media_unavailable');
    assert.ok(mock.findChapter(chapter.id).card_ids.includes(card.id), 'the card stayed in its source chapter');
    assert.equal(mock.findChapter(target.id).card_ids.includes(card.id), false, 'the card was not moved');
  });
});

test('keeps media cards queued when file availability cannot be checked', async () => {
  const wrap = (base) =>
    new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === 'queryFiles') return async () => { throw new Error('query unavailable'); };
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
  await withFixture('媒体查询失败', { wrap }, async ({ engine, mock, deck, chapter }) => {
    const card = await engine.createCard({ deck: deck.id, chapter: chapter.id, content: '[Pic#ID/mkjf_any#]' });
    const report = await engine.push();
    assert.equal(report.cards_created, 0);
    assert.equal(mock.state.cards.length, 0);
    const error = report.errors.find((entry) => entry.id === card.card_id);
    assert.ok(error);
    assert.equal(error.code, 'media_check_failed');
    const view = await engine.getCard({ card: card.card_id });
    assert.equal(view.card.status, 'new');
  });
});
