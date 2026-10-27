import test from 'node:test';
import assert from 'node:assert/strict';
import { compileFilter, FILTER_OPS } from '../lib/filter.js';

const item = {
  id: 'k1',
  text: 'Variable Initialization',
  deck: { name: 'C/C++' },
  revision: 3,
  updated_time: '2026-10-18T15:26:06Z',
  synced: true,
  conflict: null,
  tags: ['cpp', 'basics'],
};

test('filter supports every documented op', () => {
  const cases = [
    [{ field: 'text', op: 'eq', value: 'variable initialization' }, true],
    [{ field: 'text', op: 'eq', value: 'VARIABLE INITIALIZATION', case_sensitive: true }, false],
    [{ field: 'text', op: 'ne', value: 'other' }, true],
    [{ field: 'text', op: 'contains', value: 'INIT' }, true],
    [{ field: 'text', op: 'starts_with', value: 'variable' }, true],
    [{ field: 'text', op: 'ends_with', value: 'TION' }, true],
    [{ field: 'text', op: 'regex', value: 'init.*ation', flags: 'i' }, true],
    [{ field: 'id', op: 'in', value: ['k1', 'k2'] }, true],
    [{ field: 'id', op: 'not_in', value: ['k2'] }, true],
    [{ field: 'revision', op: 'gt', value: 2 }, true],
    [{ field: 'revision', op: 'gte', value: 3 }, true],
    [{ field: 'revision', op: 'lt', value: 4 }, true],
    [{ field: 'revision', op: 'lte', value: 3 }, true],
    [{ field: 'updated_time', op: 'gte', value: '2026-10-18' }, true],
    [{ field: 'conflict', op: 'exists', value: false }, true],
    [{ field: 'synced', op: 'eq', value: true }, true],
    [{ field: 'deck.name', op: 'contains', value: '/' }, true],
    [{ field: 'tags.0', op: 'eq', value: 'cpp' }, true],
  ];
  for (const [condition, expected] of cases) {
    assert.equal(compileFilter(condition)(item), expected, JSON.stringify(condition));
  }
});

test('filter groups combine all, any and not', () => {
  assert.equal(compileFilter({ all: [{ field: 'synced', op: 'eq', value: true }, { field: 'revision', op: 'gte', value: 3 }] })(item), true);
  assert.equal(compileFilter({ any: [{ field: 'id', op: 'eq', value: 'nope' }, { field: 'revision', op: 'eq', value: 3 }] })(item), true);
  assert.equal(compileFilter({ not: { field: 'id', op: 'eq', value: 'k2' } })(item), true);
  assert.equal(compileFilter({ all: [{ not: { field: 'id', op: 'eq', value: 'k2' } }, { any: [{ field: 'revision', op: 'gt', value: 5 }, { field: 'tags.1', op: 'eq', value: 'basics' }] }] })(item), true);
});

test('filter rejects invalid trees', () => {
  assert.throws(() => compileFilter(null), /filter must be an object/);
  assert.throws(() => compileFilter([]), /filter must be an object/);
  assert.throws(() => compileFilter({ field: 'id', op: 'nope', value: 1 }), /filter op/);
  assert.throws(() => compileFilter({ field: 'nope', op: 'eq', value: 1 }, { fields: ['id'] }), /unknown filter field/);
  assert.throws(() => compileFilter({ field: 'id', op: 'eq' }), /value must be/);
  assert.throws(() => compileFilter({ field: 'id', op: 'in', value: 'k1' }), /array/);
  assert.throws(() => compileFilter({ all: [] }), /non-empty array/);
  assert.throws(() => compileFilter({ all: [], field: 'id' }), /group cannot mix/);
  assert.throws(() => compileFilter({ not: { field: '__proto__', op: 'exists', value: true } }), /invalid filter field/);
  assert.throws(() => compileFilter({ field: 'constructor', op: 'exists', value: true }), /invalid filter field/);
  const deep = (n) => (n === 0 ? { field: 'id', op: 'eq', value: 'k1' } : { not: deep(n - 1) });
  assert.throws(() => compileFilter(deep(10)), /nested too deeply/);
  const many = { all: Array.from({ length: 65 }, () => ({ field: 'id', op: 'eq', value: 'k1' })) };
  assert.throws(() => compileFilter(many), /too many conditions/);
});

test('filter field lists are configurable and every op is exported', () => {
  assert.ok(FILTER_OPS.includes('contains'));
  assert.equal(compileFilter({ field: 'custom', op: 'eq', value: 'x' }, { fields: ['custom'] })({ custom: 'X' }), true);
  assert.throws(() => compileFilter({ field: 'id', op: 'eq', value: 'x' }, { fields: ['custom'] }), /unknown filter field/);
  assert.throws(() => compileFilter({ field: 'id', op: 'regex', value: '[', flags: 'i' }), /regular expression/);
  assert.throws(() => compileFilter({ field: 'id', op: 'regex', value: 'x', flags: 'g' }), /flags/);
});
