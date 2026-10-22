/**
 * Raw Markji syntax validation tests (offline).
 *
 * Run: node --test "test/card-syntax.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCardContent } from '../lib/card-syntax.js';

test('accepts raw Markji syntax and escaped literal brackets', () => {
  assert.equal(validateCardContent('正文 \\[字面括号\\]').ok, true);
  assert.equal(validateCardContent('[E##x=\\left[0,1\\right]]').ok, true, 'LaTeX bracket delimiters are not the tag close');
  assert.equal(validateCardContent('[Card#ID/4wJYw#参见]').ok, true);
  assert.equal(validateCardContent('[Pic#ID/1kIBX#]').ok, true);
  assert.equal(validateCardContent('[Audio#A,ID/1kIBX#播放]').ok, true);
  assert.equal(validateCardContent('参见 [文档](https://example.com/a)').ok, true, 'Markdown links are literal content');
  assert.equal(
    validateCardContent('[T#B#加粗]\n[Pic#ID/mkjf_x#]\n![图](data:image/png;base64,iVBORw0KGgo=)').ok,
    true,
    'a block-level Pic plus a Markdown image is valid',
  );
});

test('rejects unknown tags, invalid cloze groups and invalid formulas', () => {
  assert.equal(validateCardContent('[X##foo]').ok, false);
  assert.equal(validateCardContent('[F#0#x]').ok, false);
  assert.equal(validateCardContent('[E##$x$]').ok, false);
});

test('collects image, mask and audio file ids from valid content', () => {
  const result = validateCardContent('[Pic#ID/1kIBX,MID/mask1#]\n[Audio#A,ID/aud1#播放]');
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.media.map((entry) => [entry.kind, entry.id, entry.line]),
    [
      ['image', '1kIBX', 1],
      ['mask', 'mask1', 1],
      ['audio', 'aud1', 2],
    ],
  );
});

test('flags template placeholders and fake file ids', () => {
  const result = validateCardContent('[Pic#ID/<imageFileId>#]');
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((entry) => entry.code === 'invalid_file_id'));
  assert.ok(result.warnings.some((entry) => entry.code === 'placeholder'));
  assert.deepEqual(result.media, []);
});

test('does not alter or trim the content it validates', () => {
  const content = '  前后有空格  ';
  const result = validateCardContent(content);
  assert.equal(result.ok, true);
  assert.equal(result.stats.chars, content.length);
});

test('accepts adjacent Pic tags as one gallery but not inline after text', () => {
  assert.equal(validateCardContent('[Pic#ID/a#][Pic#ID/b#]').ok, true);
  assert.equal(validateCardContent('[Pic#ID/a#] [Pic#ID/b#]').ok, false, 'a gallery has no whitespace between tags');
  assert.equal(validateCardContent('文字[Pic#ID/a#]').ok, false, 'Pic is block-level');
});
