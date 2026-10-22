/**
 * End-to-end test over real HTTP against the mock Markji server (Lead-owned).
 *
 * Proves the real client + store + engine work together: pull-before-push merging,
 * conflict recording without aborting other cards, local id remapping for new
 * chapters/cards, moves, chapter rename/sort, conflict resolution, and that pull-only
 * sends no write requests. The user's account is never touched.
 *
 * Run: node test/e2e-mock.mjs    (E2E_VERBOSE=1 for request logging)
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockMarkji } from './mock-server.mjs';
import { createClient } from '../lib/api.js';
import { createLimiter } from '../lib/rate-limit.js';
import { createStore } from '../lib/store.js';
import { createEngine } from '../lib/sync.js';

const verbose = process.env.E2E_VERBOSE === '1';
const log = (level, message) => { if (verbose) console.log('  [' + level + '] ' + message); };
let passed = 0;
function pass(name, detail = '') {
  passed += 1;
  console.log('ok ' + passed + ' - ' + name + (detail ? ' (' + detail + ')' : ''));
}
function section(name) { console.log('\n# ' + name); }

const dir = await mkdtemp(join(tmpdir(), 'markji-e2e-'));
const mock = await startMockMarkji({ token: 'e2e-token' });
let engine = null;
let store = null;
try {
  const deck = mock.newDeck('E2E 测试牌组', { chapters: ['第一章', '第二章'] });
  const chapter1 = mock.state.chapters.find((c) => c.name === '第一章');
  const chapter2 = mock.state.chapters.find((c) => c.name === '第二章');
  const cardA = mock.newCard(deck.id, chapter1.id, '阿尔法 原始内容');
  const cardB = mock.newCard(deck.id, chapter1.id, '贝塔 原始内容');

  const config = {
    apiKey: mock.token,
    baseUrl: mock.url,
    requestTimeoutMs: 5000,
    maxRetries: 2,
    pageSize: 100,
    grammarVersion: 3,
    pullTtlMs: 0,
    autoSync: false,
    idleCheckMs: 60000,
    idleQuietMs: 10000,
    autoPullMs: 900000,
    retryBackoffMs: 300000,
    maxOutputChars: 20000,
  };
  const limiter = createLimiter({ limits: [{ windowMs: 1000, max: 1000 }], now: Date.now });
  const client = createClient({ apiKey: config.apiKey, baseUrl: config.baseUrl, timeoutMs: config.requestTimeoutMs, maxRetries: config.maxRetries, limiter, log });
  store = createStore({ dataDir: dir, log, clock: Date.now });
  engine = createEngine({ client, store, config, log, clock: Date.now });
  await engine.ready();

  section('cache pull');
  const decks = await engine.listDecks({ refresh: true });
  assert.equal(decks.decks.length, 1, 'one deck cached');
  assert.equal(decks.decks[0].name, 'E2E 测试牌组');
  const chapters = await engine.listChapters({ deck: deck.id });
  assert.equal(chapters.chapters.length, 2);
  const cards = await engine.listCards({ deck: deck.id });
  assert.equal(cards.total, 2, 'two cards cached');
  pass('initial pull caches decks, chapters and cards');

  const stats = store.stats();
  assert.ok(stats.path.endsWith('cache.db'), 'cache path: ' + stats.path);
  assert.equal(stats.cards, 2);
  assert.ok(stats.content_bytes > 0, 'card content stored inside cache.db');
  assert.equal(stats.db_bytes > 0, true, 'cache.db has bytes');
  pass('cache.db persisted with the documented schema (index + content in one file)');

  section('merge: local edit + remote edit on different cards');
  await engine.updateCard({ card: cardA.id, content: '阿尔法 本地修改 1' });
  mock.remoteEditCard(cardB.id, '贝塔 云端修改 1');
  let report = await engine.sync({ mode: 'auto' });
  assert.equal(report.ok, true, 'sync ok');
  assert.equal(report.conflicts.length, 0, 'no conflict for disjoint edits');
  assert.equal(mock.findCard(cardA.id).content, '阿尔法 本地修改 1', 'local edit pushed');
  const remoteB = await engine.getCard({ card: cardB.id });
  assert.equal(remoteB.card.content, '贝塔 云端修改 1', 'remote edit merged into cache');
  pass('pull-before-push merges remote change and pushes unrelated local edit');

  section('conflict: same card edited locally and remotely');
  await engine.updateCard({ card: cardA.id, content: '阿尔法 本地修改 2' });
  mock.remoteEditCard(cardA.id, '阿尔法 云端修改 2');
  await engine.updateCard({ card: cardB.id, content: '贝塔 本地修改 2' });
  report = await engine.sync({ mode: 'auto' });
  assert.equal(report.ok, true);
  const conflict = report.conflicts.find((c) => c.kind === 'card-both-modified' && c.card_id === cardA.id);
  assert.ok(conflict, 'conflict recorded: ' + JSON.stringify(report.conflicts));
  assert.equal(mock.findCard(cardA.id).content, '阿尔法 云端修改 2', 'conflicted card not pushed over remote');
  assert.equal(mock.findCard(cardB.id).content, '贝塔 本地修改 2', 'other card still pushed');
  const conflicted = await engine.getCard({ card: cardA.id });
  assert.equal(conflicted.card.status, 'conflict');
  assert.equal(conflicted.card.content, '阿尔法 本地修改 2', 'local intent kept');
  pass('conflict recorded, other cards keep syncing, local intent preserved');

  section('local new chapter + card with id remapping');
  const createdChapter = await engine.editChapter({ action: 'create', deck: deck.id, name: '第三章' });
  const localChapterId = createdChapter.chapter_id ?? createdChapter.id;
  assert.ok(String(localChapterId).startsWith('local_'), 'local chapter id: ' + localChapterId);
  const newCard = await engine.createCard({ deck: deck.id, chapter: localChapterId, content: '伽马 新卡片' });
  assert.ok(String(newCard.card_id).startsWith('local_'), 'local card id: ' + newCard.card_id);
  report = await engine.sync({ mode: 'auto' });
  const remoteChapter = mock.state.chapters.find((c) => c.name === '第三章');
  assert.ok(remoteChapter, 'chapter created on the cloud');
  const remoteCard = mock.state.cards.find((c) => c.content === '伽马 新卡片');
  assert.ok(remoteCard, 'card created on the cloud');
  assert.equal(remoteCard.deck_id, deck.id);
  assert.ok(remoteChapter.card_ids.includes(remoteCard.id));
  const remapped = await engine.getCard({ card: remoteCard.id });
  assert.equal(remapped.card.id, remoteCard.id, 'cache re-keyed to the real id');
  assert.equal(remapped.card.status, 'synced');
  pass('new chapter and card created, local ids remapped to cloud ids');

  section('move cards, rename chapter, sort chapters');
  await engine.moveCards({ cards: [cardB.id], to_chapter: remoteChapter.id });
  await engine.editChapter({ action: 'rename', chapter: chapter2.id, name: '第二章（改名）' });
  const order = [remoteChapter.id, chapter1.id, chapter2.id];
  await engine.editChapter({ action: 'sort', deck: deck.id, chapter_ids: order });
  report = await engine.sync({ mode: 'auto' });
  assert.ok(!report.errors.length, 'no push errors: ' + JSON.stringify(report.errors));
  assert.ok(remoteChapter.card_ids.includes(cardB.id), 'card moved');
  assert.equal(mock.findCard(cardB.id).deck_id, deck.id);
  assert.equal(mock.findChapter(chapter2.id).name, '第二章（改名）', 'chapter renamed');
  const set = mock.state.chaptersets.find((s) => s.deck_id === deck.id);
  if (process.env.E2E_DEBUG === '1') {
    console.log('DEBUG report=' + JSON.stringify(report));
    console.log('DEBUG set=' + JSON.stringify(set));
    console.log('DEBUG reqs=' + JSON.stringify(mock.requests.slice(-8).map((r) => ({ m: r.method, p: r.path, b: r.body }))));
  }
  assert.deepEqual(set.chapter_ids, order, 'chapter order applied');
  pass('moves, chapter rename and chapter sort pushed');

  section('remote deletion of a dirty card');
  await engine.updateCard({ card: cardB.id, content: '贝塔 删除前本地修改' });
  mock.remoteDeleteCard(cardB.id);
  report = await engine.sync({ mode: 'auto' });
  const deletedConflict = report.conflicts.find((c) => c.kind === 'card-remote-deleted' && c.card_id === cardB.id);
  assert.ok(deletedConflict, 'remote-deleted conflict recorded');
  let resolved = await engine.resolveConflict({ id: deletedConflict.id, strategy: 'keep_remote' });
  assert.equal(resolved.ok, true);
  report = await engine.sync({ mode: 'auto' });
  const gone = report.conflicts.find((c) => c.card_id === cardB.id && c.state === 'open');
  assert.equal(gone, undefined, 'conflict resolved');
  await assert.rejects(() => engine.getCard({ card: cardB.id }), /unknown|not found/i);
  pass('remote deletion detected, keep_remote drops the local card');

  section('resolve a both-modified conflict with keep_local');
  const openConflict = report.conflicts.find((c) => c.kind === 'card-both-modified');
  assert.ok(openConflict, 'still open conflict: ' + JSON.stringify(report.conflicts));
  resolved = await engine.resolveConflict({ id: openConflict.id, strategy: 'keep_local' });
  assert.equal(resolved.ok, true);
  report = await engine.sync({ mode: 'auto' });
  assert.ok(!report.conflicts.length, 'no open conflicts after resolve');
  assert.equal(mock.findCard(cardA.id).content, '阿尔法 本地修改 2', 'local content forced to the cloud');
  pass('keep_local resolves the conflict and pushes the local content');

  section('conflict dedupe on repeated pulls');
  const dedupeDeck = mock.newDeck('E2E 冲突去重', { chapters: ['去重章'] });
  const dedupeChapter = mock.state.chapters.find((c) => c.deck_id === dedupeDeck.id && c.name === '去重章');
  const dedupeCard = mock.newCard(dedupeDeck.id, dedupeChapter.id, '去重 原始');
  await engine.sync({ mode: 'pull', full: true });
  await engine.updateCard({ card: dedupeCard.id, content: '去重 本地' });
  mock.remoteEditCard(dedupeCard.id, '去重 云端');
  report = await engine.sync({ mode: 'auto' });
  const dedupeConflicts = report.conflicts.filter((c) => c.card_id === dedupeCard.id && c.kind === 'card-both-modified');
  assert.equal(dedupeConflicts.length, 1, 'one open conflict: ' + JSON.stringify(dedupeConflicts));
  report = await engine.sync({ mode: 'auto' });
  const repeated = report.conflicts.filter((c) => c.card_id === dedupeCard.id && c.kind === 'card-both-modified');
  assert.equal(repeated.length, 1, 'repeated sync does not duplicate the conflict');
  assert.equal(repeated[0].id, dedupeConflicts[0].id, 'same conflict id is kept');
  resolved = await engine.resolveConflict({ id: repeated[0].id, strategy: 'keep_local' });
  assert.equal(resolved.ok, true);
  report = await engine.sync({ mode: 'auto' });
  assert.equal(report.conflicts.filter((c) => c.card_id === dedupeCard.id).length, 0, 'closed after resolve');
  assert.equal(mock.findCard(dedupeCard.id).content, '去重 本地');
  pass('repeated pulls keep a single conflict and resolution closes it');

  section('remote chapter deletion with local work');
  const delDeck = mock.newDeck('E2E 删除章节', { chapters: ['将删除章', '保留章'] });
  const delChapter = mock.state.chapters.find((c) => c.deck_id === delDeck.id && c.name === '将删除章');
  await engine.sync({ mode: 'pull', full: true });
  const delLocalCard = await engine.createCard({ deck: delDeck.id, chapter: delChapter.id, content: '删除章节里的本地卡片' });
  assert.ok(String(delLocalCard.card_id).startsWith('local_'));
  mock.remoteDeleteChapter(delChapter.id);
  report = await engine.sync({ mode: 'auto' });
  const delChapterConflict = report.conflicts.find((c) => c.kind === 'chapter-revision' && c.chapter_id === delChapter.id);
  assert.ok(delChapterConflict, 'deleted chapter conflict recorded: ' + JSON.stringify(report.conflicts));
  assert.equal(delChapterConflict.op, 'delete');
  const goneChapter = await engine.listChapters({ deck: delDeck.id });
  assert.equal(goneChapter.chapters.find((c) => c.id === delChapter.id).missing, true, 'chapter flagged missing');
  resolved = await engine.resolveConflict({ id: delChapterConflict.id, strategy: 'keep_local' });
  assert.equal(resolved.ok, true);
  report = await engine.sync({ mode: 'auto' });
  const recreated = mock.state.chapters.find((c) => c.deck_id === delDeck.id && c.name === '将删除章');
  assert.ok(recreated, 'chapter re-created on the cloud: ' + JSON.stringify(mock.state.chapters.filter((c) => c.deck_id === delDeck.id)));
  const delRemoteCard = mock.state.cards.find((c) => c.content === '删除章节里的本地卡片');
  assert.ok(delRemoteCard, 'local card pushed into the re-created chapter');
  assert.ok(recreated.card_ids.includes(delRemoteCard.id));
  assert.equal(report.conflicts.length, 0, 'no open conflicts left');
  pass('deleted chapter with local work is surfaced and recoverable');

  section('move conflict: local and remote moved the same card');
  const moveDeck = mock.newDeck('E2E 移动冲突', { chapters: ['移动一', '移动二'] });
  const moveA = mock.state.chapters.find((c) => c.deck_id === moveDeck.id && c.name === '移动一');
  const moveB = mock.state.chapters.find((c) => c.deck_id === moveDeck.id && c.name === '移动二');
  const moveCard = mock.newCard(moveDeck.id, moveA.id, '移动冲突卡片');
  await engine.sync({ mode: 'pull', full: true });
  await engine.moveCards({ cards: [moveCard.id], to_chapter: moveB.id });
  const moveC = mock.newChapter(moveDeck.id, '移动三');
  mock.remoteMoveCard(moveCard.id, moveC.id);
  report = await engine.sync({ mode: 'auto' });
  const moveConflict = report.conflicts.find((c) => c.kind === 'card-move-conflict' && c.card_id === moveCard.id);
  assert.ok(moveConflict, 'move conflict recorded: ' + JSON.stringify(report.conflicts));
  assert.equal(moveConflict.local, moveB.id, 'local target recorded');
  assert.equal(moveConflict.remote, moveC.id, 'remote target recorded');
  resolved = await engine.resolveConflict({ id: moveConflict.id, strategy: 'keep_local' });
  assert.equal(resolved.ok, true);
  report = await engine.sync({ mode: 'auto' });
  assert.ok(!report.errors.length, 'no push errors after keep_local: ' + JSON.stringify(report.errors));
  assert.ok(mock.findChapter(moveB.id).card_ids.includes(moveCard.id), 'card moved to the local target');
  assert.equal(report.conflicts.length, 0, 'no open conflicts left');
  pass('move conflict recorded and keep_local re-queues the move');

  section('pull-only sends no write requests');
  const before = mock.requests.length;
  await engine.sync({ mode: 'pull', full: true });
  const pulls = mock.requests.slice(before);
  assert.ok(pulls.length > 0, 'pull made requests');
  assert.ok(pulls.every((r) => r.method === 'GET'), 'pull-only sent GET only: ' + JSON.stringify(pulls.filter((r) => r.method !== 'GET')));
  pass('pull never writes');

  const status = await engine.status();
  assert.ok(status.cache && status.cache.cards >= 2);
  assert.deepEqual(status.conflicts, []);
  pass('status reports cache state and no open conflicts');

  await engine.stop();
  engine = null;
  console.log('\nE2E PASS: ' + passed + ' checks, 0 failures');
} catch (error) {
  console.error('\nE2E FAIL: ' + (error && error.stack ? error.stack : String(error)));
  process.exitCode = 1;
} finally {
  if (engine) { try { await engine.stop(); } catch { /* ignore */ } }
  if (store) { try { await store.close(); } catch { /* ignore */ } }
  try { await mock.stop(); } catch { /* ignore */ }
  try { await rm(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}
