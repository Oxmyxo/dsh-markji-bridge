// Safe JSON filter trees for cached list filters.
//
// A filter is a JSON tree, never JavaScript: a condition
// { field, op, value } plus { all }, { any } or { not } groups. Values are read
// only through own properties, so a filter cannot reach prototypes or code.

export const FILTER_OPS = [
  'eq',
  'ne',
  'contains',
  'starts_with',
  'ends_with',
  'regex',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
];

const MAX_DEPTH = 8;
const MAX_NODES = 64;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const REGEX_FLAGS = /^[imsu]*$/;
const MAX_REGEX_SOURCE = 500;
// Reject the classic nested-quantifier shape; JS has no regex timeout, so a
// short pattern that can backtrack exponentially must not reach thousands of
// cached cards. This is a guard, not a general regex safety proof.
const UNSAFE_REGEX = /\((?:[^()]|\([^()]*\))*[+*](?:[^()]|\([^()]*\))*\)[+*]/;

/** Compile one condition's regex without accepting unsafe patterns or flags. */
function compileRegex(source, flags) {
  const raw = String(source);
  if (raw.length > MAX_REGEX_SOURCE) throw new Error('pattern is longer than ' + MAX_REGEX_SOURCE + ' characters');
  const rawFlags = flags === undefined || flags === null ? 'i' : String(flags);
  if (!REGEX_FLAGS.test(rawFlags)) throw new Error('flags may contain only i, m, s and u');
  if (new Set(Array.from(rawFlags)).size !== Array.from(rawFlags).length) throw new Error('flags must not repeat a flag');
  if (UNSAFE_REGEX.test(raw)) throw new Error('pattern looks like a nested-quantifier regex; simplify it');
  try {
    return new RegExp(raw, rawFlags);
  } catch (error) {
    throw new Error('not a valid regular expression: ' + (error && error.message ? error.message : String(error)));
  }
}

const GROUP_KEYS = new Set(['all', 'any', 'not']);
const CONDITION_KEYS = new Set(['field', 'op', 'value', 'case_sensitive', 'flags']);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function normalizeText(value) {
  return String(value).normalize('NFKC').toLowerCase();
}

function readPath(entity, path) {
  const parts = path.split('.');
  let value = entity;
  for (const part of parts) {
    if (value === null || typeof value !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function compareValues(left, right) {
  if (typeof left === 'number' && typeof right === 'number') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left === right ? 0 : left < right ? -1 : 1;
  }
  return null;
}

function equals(left, right, caseSensitive) {
  if (left === right) return true;
  if (typeof left === 'string' && typeof right === 'string') {
    return caseSensitive ? left === right : normalizeText(left) === normalizeText(right);
  }
  return false;
}

function textOf(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}

function compileCondition(node) {
  const keys = Object.keys(node);
  const groupKeys = keys.filter((key) => GROUP_KEYS.has(key));
  if (groupKeys.length > 0) {
    fail('filter group must be { all: [...] }, { any: [...] } or { not: {...} }');
  }
  for (const key of keys) {
    if (!CONDITION_KEYS.has(key)) fail('unknown filter key: ' + key);
  }
  if (typeof node.field !== 'string' || node.field.trim() === '') fail('filter condition requires a non-empty field');
  if (typeof node.op !== 'string' || !FILTER_OPS.includes(node.op)) {
    fail('filter op must be one of: ' + FILTER_OPS.join(', '));
  }
  const field = node.field.trim();
  const path = field.split('.');
  if (path.some((part) => part === '' || FORBIDDEN_KEYS.has(part))) fail('invalid filter field: ' + field);
  const op = node.op;
  const caseSensitive = node.case_sensitive === true;
  if (node.case_sensitive !== undefined && typeof node.case_sensitive !== 'boolean') {
    fail('filter case_sensitive must be a boolean');
  }
  const flags = node.flags === undefined ? (caseSensitive ? '' : undefined) : String(node.flags);
  let value = node.value;
  let regex = null;
  let list = null;

  if (op === 'exists') {
    if (value !== undefined && typeof value !== 'boolean') fail('filter exists value must be a boolean');
    value = value === undefined ? true : value;
  } else if (op === 'regex') {
    if (typeof value !== 'string' || value === '') fail('filter regex value must be a non-empty string');
    try {
      regex = compileRegex(value, flags);
    } catch (error) {
      fail('filter regex: ' + (error && error.message ? error.message : String(error)));
    }
  } else if (op === 'in' || op === 'not_in') {
    if (!Array.isArray(value) || value.length === 0) fail('filter ' + op + ' value must be a non-empty array');
    if (!value.every(isPrimitive)) fail('filter ' + op + ' value must contain only strings, numbers, booleans or null');
    list = value;
  } else if (op === 'contains' || op === 'starts_with' || op === 'ends_with') {
    const text = textOf(value);
    if (text === null) fail('filter ' + op + ' value must be a string or number');
    value = text;
  } else if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    if (typeof value !== 'number' && typeof value !== 'string') fail('filter ' + op + ' value must be a number or string');
  } else if (!isPrimitive(value)) {
    fail('filter ' + op + ' value must be a string, number, boolean or null');
  }

  return (entity) => {
    const left = readPath(entity, field);
    switch (op) {
      case 'exists':
        return value ? left !== undefined && left !== null : left === undefined || left === null;
      case 'eq':
        return equals(left, value, caseSensitive);
      case 'ne':
        return !equals(left, value, caseSensitive);
      case 'in':
        return list.some((item) => equals(left, item, caseSensitive));
      case 'not_in':
        return !list.some((item) => equals(left, item, caseSensitive));
      case 'contains':
      case 'starts_with':
      case 'ends_with': {
        const text = textOf(left);
        if (text === null) return false;
        const haystack = caseSensitive ? text : normalizeText(text);
        const needle = caseSensitive ? value : normalizeText(value);
        if (op === 'contains') return haystack.includes(needle);
        if (op === 'starts_with') return haystack.startsWith(needle);
        return haystack.endsWith(needle);
      }
      case 'regex': {
        const text = textOf(left);
        return text !== null && regex.test(text);
      }
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte': {
        const order = compareValues(left, value);
        if (order === null) return false;
        if (op === 'gt') return order > 0;
        if (op === 'gte') return order >= 0;
        if (op === 'lt') return order < 0;
        return order <= 0;
      }
      default:
        return false;
    }
  };
}

/**
 * Compile a filter tree into a function over one list entity.
 *
 * @param {unknown} tree - JSON filter tree.
 * @param {{fields?: string[]}} [options] - Allowed top-level field roots.
 * @returns {(entity: object) => boolean}
 */
export function compileFilter(tree, options = {}) {
  const allowed = Array.isArray(options.fields) ? new Set(options.fields) : null;
  let nodes = 0;

  function compileNode(node, depth) {
    if (depth > MAX_DEPTH) fail('filter is nested too deeply (max ' + MAX_DEPTH + ')');
    if (!isObject(node)) fail('filter must be an object');
    nodes += 1;
    if (nodes > MAX_NODES) fail('filter has too many conditions (max ' + MAX_NODES + ')');
    const keys = Object.keys(node);
    const groupKeys = keys.filter((key) => GROUP_KEYS.has(key));
    if (groupKeys.length > 0) {
      if (keys.length !== 1) fail('filter group cannot mix with field/op/value keys');
      const key = groupKeys[0];
      if (key === 'not') {
        const child = compileNode(node.not, depth + 1);
        return (entity) => !child(entity);
      }
      if (!Array.isArray(node[key]) || node[key].length === 0) fail('filter ' + key + ' must be a non-empty array');
      const children = node[key].map((child) => compileNode(child, depth + 1));
      return key === 'all'
        ? (entity) => children.every((child) => child(entity))
        : (entity) => children.some((child) => child(entity));
    }
    if (allowed !== null) {
      const root = String(node.field).trim().split('.')[0];
      if (!allowed.has(root)) {
        fail('unknown filter field: ' + node.field + '; allowed fields: ' + [...allowed].join(', '));
      }
    }
    return compileCondition(node);
  }

  return compileNode(tree, 0);
}
