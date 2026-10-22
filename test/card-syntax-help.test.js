/**
 * Static syntax help tests (offline).
 *
 * Run: node --test "test/card-syntax-help.test.js"
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { getSyntaxHelp } from '../lib/card-syntax-help.js';
import { validateCardContent } from '../lib/card-syntax.js';

test('returns every format and the general rules when format is omitted', () => {
  const all = getSyntaxHelp();
  assert.equal(all.ok, true);
  assert.equal(all.action, 'help');
  assert.equal(all.format, 'all');
  assert.ok(all.rules.length >= 8);
  assert.ok(all.nesting.length >= 5);
  assert.deepEqual(
    all.formats.map((entry) => entry.tag),
    ['T', 'F', 'Audio', 'Card', 'P', 'Choice', 'Pic', 'E', '---'],
  );
  assert.ok(JSON.stringify(all, null, 2).length < 20000, 'all help must fit the default output limit');
});

test('looks up one format by id, tag, or Chinese alias', () => {
  for (const query of ['picture', 'Pic', '图片']) {
    const help = getSyntaxHelp(query);
    assert.equal(help.ok, true);
    assert.equal(help.format, 'picture');
    assert.equal(help.tag, 'Pic');
    assert.ok(help.examples.some((example) => example.includes('[Pic#ID/')));
  }
  assert.equal(getSyntaxHelp('T').format, 'text-style');
  assert.equal(getSyntaxHelp('formula').tag, 'E');
  assert.equal(getSyntaxHelp('---').format, 'answer-line');
  assert.equal(getSyntaxHelp('P').kind, 'block');
});

test('returns general rules for basic and a structured error for an unknown format', () => {
  const basic = getSyntaxHelp('basic');
  assert.equal(basic.ok, true);
  assert.equal(basic.format, 'basic');
  assert.ok(basic.rules.length > 0);
  assert.equal(basic.formats, undefined);

  const explicitAll = getSyntaxHelp('all');
  assert.equal(explicitAll.ok, true);
  assert.equal(explicitAll.formats.length, 9);

  const unknown = getSyntaxHelp('not-a-format');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.error, 'unknown_format');
  assert.ok(unknown.available_formats.some((entry) => entry.format === 'formula'));
});

test('every documented example is accepted by the syntax validator', () => {
  const all = getSyntaxHelp();
  for (const entry of all.formats) {
    for (const example of entry.examples) {
      const result = validateCardContent(example);
      assert.equal(
        result.ok,
        true,
        entry.format + ' example failed: ' + JSON.stringify(example) + ' ' + JSON.stringify(result.errors),
      );
    }
  }
});
