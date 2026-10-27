/**
 * lib/preflight.js contract: syntax + media availability shared by the write
 * (lib/tools.js) and push (lib/sync.js) paths.
 *
 * Run: node --test "test/preflight.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_MEDIA_QUERY_BATCH, missingMedia, preflightContent, queryAvailableMedia, uniqueMedia } from '../lib/preflight.js';

function fakeClient(available = new Set(), calls = []) {
  return {
    async queryFiles({ ids }) {
      calls.push([...ids]);
      return ids.filter((id) => available.has(id)).map((id) => ({ id }));
    },
  };
}

test('syntax-only preflight returns the documented shape and media refs', async () => {
  const okResult = await preflightContent('正文\n[Pic#ID/mkjf_a#]');
  assert.deepEqual(Object.keys(okResult).sort(), ['errors', 'media', 'ok', 'warnings']);
  assert.equal(okResult.ok, true);
  assert.deepEqual(okResult.media, [{ kind: 'image', id: 'mkjf_a', line: 2, column: 1 }]);
  assert.deepEqual(okResult.warnings, []);

  const bad = await preflightContent('[X##bad]');
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, 'unknown_tag');

  const warned = await preflightContent('正文 <imageFileId>');
  assert.equal(warned.ok, true);
  assert.equal(warned.warnings[0].code, 'placeholder');
});

test('without a client no media request is made and media is reported unresolved', async () => {
  const calls = [];
  const client = fakeClient(new Set(), calls);
  const result = await preflightContent('[Pic#ID/mkjf_missing#]', { client: null });
  assert.equal(result.ok, true, 'syntax-only mode does not fail on media');
  assert.equal(calls.length, 0);
  assert.equal(result.media[0].id, 'mkjf_missing');
});

test('a media check rejects only the ids the provider does not return', async () => {
  const calls = [];
  const client = fakeClient(new Set(['mkjf_a']), calls);
  const result = await preflightContent('[Pic#ID/mkjf_a#][Pic#ID/mkjf_b#]', { client });
  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  const mediaErrors = result.errors.filter((entry) => entry.code === 'media_unavailable');
  assert.deepEqual(mediaErrors.map((entry) => entry.media), [{ kind: 'image', id: 'mkjf_b' }]);
  assert.match(mediaErrors[0].message, /mkjf_b/);
});

test('ids are deduplicated and queried in batches of at most 100', async () => {
  const ids = Array.from({ length: 250 }, (_, index) => 'mkjf_' + index);
  const available = new Set(ids.filter((id) => Number(id.split('_')[1]) % 2 === 0));
  const calls = [];
  const client = fakeClient(available, calls);
  const media = ids.map((id) => ({ kind: 'image', id, line: 1, column: 1 }));
  const availableSet = await queryAvailableMedia(client, [...ids, ...ids], 1000);
  assert.deepEqual(calls.map((batch) => batch.length), [100, 100, 50]);
  assert.equal(calls.flat().length, 250, 'duplicate ids are collapsed');
  assert.equal(availableSet.size, 125);
  assert.equal(MAX_MEDIA_QUERY_BATCH, 100);

  const small = [];
  const smallClient = fakeClient(new Set(), small);
  await queryAvailableMedia(smallClient, ['a', 'b', 'c'], 2);
  assert.deepEqual(small.map((batch) => batch.length), [2, 1]);

  // The same file id used as an image and as a mask stays two references.
  assert.equal(uniqueMedia([...media, { kind: 'mask', id: 'mkjf_0', line: 1, column: 1 }]).length, 251);
  assert.equal(missingMedia([{ kind: 'image', id: 'mkjf_0' }], new Set()).length, 1);
});

test('a failed media query becomes media_check_failed instead of throwing', async () => {
  const client = {
    async queryFiles() {
      throw new Error('network down');
    },
  };
  const result = await preflightContent('[Pic#ID/mkjf_a#]', { client });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'media_check_failed');
  assert.match(result.errors[0].message, /network down/);
});

test('an unavailable client is reported as media_check_failed', async () => {
  const result = await preflightContent('[Pic#ID/mkjf_a#]', { client: {} });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'media_check_failed');
});

test('invalid syntax skips the media query', async () => {
  const calls = [];
  const client = fakeClient(new Set(), calls);
  const result = await preflightContent('[X##bad] [Pic#ID/mkjf_missing#]', { client });
  assert.equal(result.ok, false);
  assert.equal(result.errors[0].code, 'unknown_tag');
  assert.equal(calls.length, 0, 'media is not queried when the body cannot be parsed');
});

test('availableMedia lets a caller share one batched query across contents', async () => {
  const calls = [];
  const client = fakeClient(new Set(), calls);
  const shared = new Set(['mkjf_a']);
  assert.equal((await preflightContent('[Pic#ID/mkjf_a#]', { client, availableMedia: shared })).ok, true);
  assert.equal((await preflightContent('[Pic#ID/mkjf_b#]', { client, availableMedia: shared })).ok, false);
  assert.equal(calls.length, 0);
});
