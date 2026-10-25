/**
 * Batch tool tests: multiple card reads, syntax validation, and updates.
 *
 * Run: node --test "test/batch.test.js"
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
import { registerTools } from '../lib/tools.js';

function makeConfig(mock) {
  return {
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
}

async function withFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'markji-batch-'));
  const mock = await startMockMarkji({ token: 'batch-token' });
  let engine = null;
  let store = null;
  try {
    const deck = mock.newDeck('批量测试', { chapters: ['普通'] });
    const chapter = mock.state.chapters[0];
    const good = mock.newCard(deck.id, chapter.id, '第一张正常卡片');
    const alsoGood = mock.newCard(deck.id, chapter.id, '第二张 [E##x+y] 卡片');
    const bad = mock.newCard(deck.id, chapter.id, '[X##bad]');
    const config = makeConfig(mock);
    const limiter = createLimiter({ limits: [{ windowMs: 1000, max: 1000 }], now: Date.now });
    const client = createClient({
      apiKey: config.apiKey,
      baseUrl: config.baseUrl,
      timeoutMs: config.requestTimeoutMs,
      maxRetries: config.maxRetries,
      limiter,
      log: () => {},
    });
    store = createStore({ dataDir: dir, log: () => {}, clock: Date.now });
    engine = createEngine({ client, store, config, log: () => {}, clock: Date.now });
    await engine.ready();
    await engine.sync({ mode: 'pull', full: true });
    const registered = new Map();
    const dispose = registerTools(
      {
        tools: {
          register(definition) {
            registered.set(definition.name, definition);
            return () => {};
          },
        },
      },
      { engine, config, log: () => {}, client },
    );
    try {
      await run({
        call: (name, args) => registered.get(name).execute(args),
        registered,
        engine,
        mock,
        deck,
        chapter,
        good,
        alsoGood,
        bad,
      });
    } finally {
      dispose();
    }
  } finally {
    if (engine) await engine.stop();
    if (store) await store.close();
    await mock.stop();
    await rm(dir, { recursive: true, force: true });
  }
}

test('markji_cards action=get returns several cards in request order and isolates unknown ids', async () => {
  await withFixture(async ({ call, good, alsoGood }) => {
    const result = await call('markji_cards', { action: 'get', cards: [alsoGood.id, good.id, 'missing_card_id'] });
    assert.equal(result.cards.length, 2);
    assert.deepEqual(result.missing, ['missing_card_id']);
    assert.equal(result.cards[0].id, alsoGood.id);
    assert.match(result.cards[0].content, /第二张/);
    assert.equal(result.cards[0].text, undefined, 'text is omitted by default');
    assert.equal(result.cards[1].id, good.id);

    const withText = await call('markji_cards', { action: 'get', cards: [good.id], include_text: true });
    assert.match(withText.cards[0].text, /第一张正常卡片/);
  });
});

test('markji_cards action=validate validates multiple raw bodies and multiple cached cards', async () => {
  await withFixture(async ({ call, good, alsoGood, bad }) => {
    const raw = await call('markji_cards', { action: 'validate', contents: ['第一段 \\[字面括号\\]', '[X##bad]'] });
    assert.equal(raw.mode, 'batch');
    assert.equal(raw.source, 'contents');
    assert.equal(raw.total, 2);
    assert.equal(raw.valid, 1);
    assert.equal(raw.invalid, 1);
    assert.equal(raw.results[0].ok, true);
    assert.equal(raw.results[1].ok, false);
    assert.equal(raw.results[1].errors[0].code, 'unknown_tag');

    const cards = await call('markji_cards', { action: 'validate', cards: [good.id, alsoGood.id, bad.id, 'missing_card_id'] });
    assert.equal(cards.mode, 'batch');
    assert.equal(cards.source, 'cards');
    assert.equal(cards.total, 4);
    assert.equal(cards.valid, 2);
    assert.equal(cards.invalid, 2);
    assert.equal(cards.missing, 1);
    assert.equal(cards.syntax_invalid, 1);
    assert.equal(cards.results[0].card_id, good.id);
    assert.equal(cards.results[0].content_source, 'content');
    assert.equal(cards.results[2].errors[0].code, 'unknown_tag');
    assert.equal(cards.results[3].error.code, 'unknown_card');

    await call('markji_cards', { action: 'update', card: good.id, content: '排队中的新正文' });
    const pending = await call('markji_cards', { action: 'validate', cards: [good.id] });
    assert.equal(pending.results[0].content_source, 'pending');
    assert.equal(pending.results[0].content_length, '排队中的新正文'.length);
    assert.equal(pending.valid, 1);
  });
});

test('markji_cards action=update batch queues good items and reports bad items without aborting', async () => {
  await withFixture(async ({ call, engine, good, bad }) => {
    const result = await call('markji_cards', { action: 'update',
      updates: [
        { card: good.id, content: '批量修改后的第一张' },
        { card: bad.id, content: '' },
        { card: 'missing_card_id', content: '不会排队' },
      ],
    });
    assert.equal(result.mode, 'batch');
    assert.equal(result.total, 3);
    assert.equal(result.updated, 1);
    assert.equal(result.failed, 2);
    assert.equal(result.partial, true);
    assert.equal(result.ok, false);
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[1].ok, false);
    assert.equal(result.results[1].card_id, bad.id);
    assert.equal(result.results[2].ok, false);
    assert.equal(result.results[2].error.code, 'unknown_card');
    const card = engine._internal.orderedCards().find((entry) => entry.id === good.id);
    assert.equal(card.content, '批量修改后的第一张');
    assert.ok(card.pending);
    assert.equal(bad.id, engine._internal.orderedCards().find((entry) => entry.id === bad.id).id);
  });
});

test('markji_cards action=create queues several local cards and isolates a bad item', async () => {
  await withFixture(async ({ call, engine, deck, chapter }) => {
    const result = await call('markji_cards', { action: 'create',
      deck: deck.id,
      chapter: chapter.id,
      new_cards: [
        { content: '批量新建一' },
        { content: '批量新建二 [E##x+y]' },
        { content: '' },
      ],
    });
    assert.equal(result.mode, 'batch');
    assert.equal(result.total, 3);
    assert.equal(result.created, 2);
    assert.equal(result.failed, 1);
    assert.equal(result.partial, true);
    assert.equal(result.ok, false);
    assert.match(result.results[0].card_id, /^local_cd/);
    assert.match(result.results[1].card_id, /^local_cd/);
    assert.equal(result.results[2].ok, false);
    const first = await engine.getCard({ card: result.results[0].card_id });
    assert.equal(first.card.content, '批量新建一');
    assert.equal(first.card.status, 'new');
    assert.equal(first.card.chapter_id, chapter.id);
  });
});

test('markji_cards action=create can target different chapters and decks per item', async () => {
  await withFixture(async ({ call, engine, mock, deck, chapter }) => {
    const extraChapter = mock.newChapter(deck.id, '第二章节');
    const otherDeck = mock.newDeck('另一卡组', { chapters: ['另一章节'] });
    const otherChapter = mock.state.chapters.find((entry) => entry.deck_id === otherDeck.id);
    await engine.sync({ mode: 'pull', full: true });

    const mixed = await call('markji_cards', { action: 'create',
      deck: deck.id,
      chapter: chapter.id,
      new_cards: [
        { content: '默认目标' },
        { content: '同卡组另一章节', chapter: extraChapter.id },
        { content: '跨卡组', deck: otherDeck.id, chapter: otherChapter.id },
      ],
    });
    assert.equal(mixed.created, 3);
    assert.equal(mixed.deck_id, deck.id);
    assert.equal(mixed.chapter_id, chapter.id);
    assert.equal(mixed.results[0].chapter_id, chapter.id);
    assert.equal(mixed.results[1].chapter_id, extraChapter.id);
    assert.equal(mixed.results[2].deck_id, otherDeck.id);

    const result = await call('markji_cards', {
      action: 'create',
      new_cards: [
        { content: '默认目标', deck: deck.id, chapter: chapter.id },
        { content: '同卡组另一章节', deck: deck.id, chapter: extraChapter.id },
        { content: '跨卡组', deck: otherDeck.id, chapter: otherChapter.id },
        { content: '缺少目标' },
      ],
    });
    assert.equal(result.total, 4);
    assert.equal(result.created, 3);
    assert.equal(result.failed, 1);
    assert.equal(result.partial, true);
    assert.equal(result.ok, false);
    assert.equal(result.deck_id, null);
    assert.equal(result.chapter_id, null);
    assert.equal(result.results[0].deck_id, deck.id);
    assert.equal(result.results[0].chapter_id, chapter.id);
    assert.equal(result.results[1].chapter_id, extraChapter.id);
    assert.equal(result.results[2].deck_id, otherDeck.id);
    assert.equal(result.results[2].chapter_id, otherChapter.id);
    assert.equal(result.results[3].ok, false);
    assert.match(result.results[3].error.message, /needs deck and chapter/);

    const crossDeck = await engine.getCard({ card: result.results[2].card_id });
    assert.equal(crossDeck.card.deck_id, otherDeck.id);
    assert.equal(crossDeck.card.chapter_id, otherChapter.id);
    assert.equal(crossDeck.card.content, '跨卡组');
  });
});

test('markji_decks returns deck detail and supports chapter create/get/rename/sort', async () => {
  await withFixture(async ({ call, engine, deck }) => {
    const detail = await call('markji_decks', { action: 'get', deck: deck.id });
    assert.equal(detail.deck.id, deck.id);
    assert.equal(detail.deck.name, '批量测试');
    assert.ok(detail.chapters.length >= 1, 'deck detail includes chapters');
    assert.equal(detail.deck.chapter_count, detail.chapters.length);

    const created = await call('markji_decks', { action: 'chapter_create', deck: deck.id, name: '新章节' });
    assert.equal(created.ok, true);
    assert.match(created.chapter_id, /^local_/);

    const got = await call('markji_decks', {
      action: 'chapter_get',
      chapter: created.chapter_id,
      with_cards: true,
    });
    assert.equal(got.chapter.id, created.chapter_id);
    assert.equal(got.chapter.name, '新章节');
    assert.equal(got.deck_id, deck.id);
    assert.deepEqual(got.cards, []);

    const renamed = await call('markji_decks', {
      action: 'chapter_rename',
      chapter: created.chapter_id,
      name: '重命名章节',
    });
    assert.equal(renamed.ok, true);
    const afterRename = await call('markji_decks', { action: 'chapter_get', chapter: created.chapter_id });
    assert.equal(afterRename.chapter.name, '重命名章节');

    const listed = await call('markji_decks', { action: 'chapter_list', deck: deck.id });
    assert.equal(listed.deck_id, deck.id);
    const ids = listed.chapters.map((chapter) => chapter.id).reverse();
    const sorted = await call('markji_decks', { action: 'chapter_sort', deck: deck.id, chapter_ids: ids });
    assert.equal(sorted.ok, true);
    const afterSort = await call('markji_decks', { action: 'get', deck: deck.id });
    assert.deepEqual(afterSort.chapters.map((chapter) => chapter.id), ids);
  });
});
