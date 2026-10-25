import test from 'node:test';
import assert from 'node:assert/strict';
import { compilePredicate, PREDICATE_OPS } from '../lib/predicate.js';

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

test('predicate supports every documented op', () => {
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
    assert.equal(compilePredicate(condition)(item), expected, JSON.stringify(condition));
  }
});

test('predicate groups combine all, any and not', () => {
  assert.equal(compilePredicate({ all: [{ field: 'synced', op: 'eq', value: true }, { field: 'revision', op: 'gte', value: 3 }] })(item), true);
  assert.equal(compilePredicate({ any: [{ field: 'id', op: 'eq', value: 'nope' }, { field: 'revision', op: 'eq', value: 3 }] })(item), true);
  assert.equal(compilePredicate({ not: { field: 'id', op: 'eq', value: 'k2' } })(item), true);
  assert.equal(compilePredicate({ all: [{ not: { field: 'id', op: 'eq', value: 'k2' } }, { any: [{ field: 'revision', op: 'gt', value: 5 }, { field: 'tags.1', op: 'eq', value: 'basics' }] }] })(item), true);
});

test('predicate rejects invalid trees', () => {
  assert.throws(() => compilePredicate(null), /predicate must be an object/);
  assert.throws(() => compilePredicate([]), /predicate must be an object/);
  assert.throws(() => compilePredicate({ field: 'id', op: 'nope', value: 1 }), /predicate op/);
  assert.throws(() => compilePredicate({ field: 'nope', op: 'eq', value: 1 }, { fields: ['id'] }), /unknown predicate field/);
  assert.throws(() => compilePredicate({ field: 'id', op: 'eq' }), /value must be/);
  assert.throws(() => compilePredicate({ field: 'id', op: 'in', value: 'k1' }), /array/);
  assert.throws(() => compilePredicate({ all: [] }), /non-empty array/);
  assert.throws(() => compilePredicate({ all: [], field: 'id' }), /group cannot mix/);
  assert.throws(() => compilePredicate({ not: { field: '__proto__', op: 'exists', value: true } }), /invalid predicate field/);
  assert.throws(() => compilePredicate({ field: 'constructor', op: 'exists', value: true }), /invalid predicate field/);
  const deep = (n) => (n === 0 ? { field: 'id', op: 'eq', value: 'k1' } : { not: deep(n - 1) });
  assert.throws(() => compilePredicate(deep(10)), /nested too deeply/);
  const many = { all: Array.from({ length: 65 }, () => ({ field: 'id', op: 'eq', value: 'k1' })) };
  assert.throws(() => compilePredicate(many), /too many conditions/);
});

test('predicate fields lists are configurable and every op is exported', () => {
  assert.ok(PREDICATE_OPS.includes('contains'));
  assert.equal(compilePredicate({ field: 'custom', op: 'eq', value: 'x' }, { fields: ['custom'] })({ custom: 'X' }), true);
  assert.throws(() => compilePredicate({ field: 'id', op: 'eq', value: 'x' }, { fields: ['custom'] }), /unknown predicate field/);
  assert.throws(() => compilePredicate({ field: 'id', op: 'regex', value: '[', flags: 'i' }), /regular expression/);
  assert.throws(() => compilePredicate({ field: 'id', op: 'regex', value: 'x', flags: 'g' }), /flags/);
});
