// Query matching for cached card search: substring, fuzzy and regular expression.
// Pure functions only; the sync engine owns cache access and response shaping.

/** Supported query modes, in default order. */
export const SEARCH_MODES = ['substring', 'fuzzy', 'regex'];
export const DEFAULT_REGEX_FLAGS = 'i';
export const DEFAULT_FUZZY_MIN_SCORE = 0.6;

const MAX_QUERY_LENGTH = 500;
const MAX_FUZZY_QUERY_LENGTH = 200;
const MAX_WINDOWS = 80;
// A multi-term fuzzy query should not pass because one common word matched
// exactly while another term only vaguely resembles a different word.
export const MULTI_TERM_MIN_TERM_SCORE = 0.8;
const REGEX_FLAGS = /^[imsu]*$/;
// Reject the classic nested-quantifier shape; JS has no regex timeout, so a
// short pattern that can backtrack exponentially must not reach thousands of
// cached cards. This is a guard, not a general regex safety proof.
const UNSAFE_REGEX = /\((?:[^()]|\([^()]*\))*[+*](?:[^()]|\([^()]*\))*\)[+*]/;

function normalize(value) {
  return String(value).normalize('NFKC').toLowerCase();
}

/** Normalize for fuzzy matching: compatibility forms, lower case, punctuation
 * to spaces so Chinese/English mixed text shares one representation. */
function normalizeFuzzy(value) {
  return normalize(value)
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function charsOf(value) {
  return Array.from(value);
}

/** Bounded Levenshtein distance; returns maxDistance + 1 once the bound is
 * exceeded, so a bad window is cheap. */
function editDistance(a, b, maxDistance) {
  const left = charsOf(a);
  const right = charsOf(b);
  const lengthDelta = Math.abs(left.length - right.length);
  if (lengthDelta > maxDistance) return maxDistance + 1;
  let previous = new Array(right.length + 1);
  for (let index = 0; index <= right.length; index += 1) previous[index] = index;
  for (let i = 1; i <= left.length; i += 1) {
    const current = new Array(right.length + 1);
    current[0] = i;
    let rowMinimum = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      if (current[j] < rowMinimum) rowMinimum = current[j];
    }
    if (rowMinimum > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length];
}

/** Best approximate match of query against a window of text. Windows are
 * centered on characters shared by query and text; this keeps long cards cheap
 * while still handling one-character substitutions and insertions. */
function bestWindow(query, text) {
  const queryChars = charsOf(query);
  if (queryChars.length === 0) return null;
  const exact = text.indexOf(query);
  if (exact >= 0) return { score: 1, index: exact, length: queryChars.length };
  if (queryChars.length < 2) return null;
  const textChars = charsOf(text);
  const shared = new Set(queryChars.filter((char) => char !== ' '));
  if (shared.size === 0) return null;
  const starts = [];
  for (let index = 0; index < textChars.length; index += 1) {
    if (shared.has(textChars[index])) starts.push(index);
  }
  if (starts.length === 0) return null;
  const candidates = [];
  const wanted = Math.min(MAX_WINDOWS, starts.length);
  const step = starts.length / wanted;
  for (let index = 0; index < wanted; index += 1) {
    const start = starts[Math.floor(index * step)];
    if (candidates[candidates.length - 1] !== start) candidates.push(start);
  }
  let best = { score: 0, index: -1, length: queryChars.length };
  for (const start of candidates) {
    for (const delta of [-1, 0, 1]) {
      const windowLength = queryChars.length + delta;
      if (windowLength < 2 || start + windowLength > textChars.length) continue;
      const window = textChars.slice(start, start + windowLength).join('');
      const maxDistance = Math.floor(Math.max(queryChars.length, windowLength) * 0.5);
      const distance = editDistance(query, window, maxDistance);
      const score = 1 - distance / Math.max(queryChars.length, windowLength);
      if (score > best.score) best = { score, index: start, length: windowLength };
    }
    if (best.score >= 1) break;
  }
  return best.score > 0 ? best : null;
}

/** Best approximate match for one term. Short terms only match exactly, so
 * "bind" cannot be found inside unrelated words and short query noise stays low. */
function fuzzyTerm(term, text) {
  const exact = text.indexOf(term);
  if (exact >= 0) return { score: 1, index: exact, length: term.length };
  if (charsOf(term).length < 2) return { score: 0, index: -1, length: 0 };
  return bestWindow(term, text) ?? { score: 0, index: -1, length: 0 };
}

function fuzzyMatch(query, text) {
  const normalizedQuery = normalizeFuzzy(query);
  const normalizedText = normalizeFuzzy(text);
  if (normalizedQuery === '' || normalizedText === '') return null;
  const exact = normalizedText.indexOf(normalizedQuery);
  if (exact >= 0) return { score: 1, index: exact, length: normalizedQuery.length };
  const terms = normalizedQuery.split(' ').filter((term) => term !== '');
  if (terms.length === 1) {
    const hit = fuzzyTerm(terms[0], normalizedText);
    return hit.score > 0 ? hit : null;
  }
  // Multiple space-separated terms are ANDed: one missing concept should not
  // match a card that merely shares a few characters. Scores average over terms,
  // so a long keyword list cannot pass on one exact word.
  let total = 0;
  let best = { score: 0, index: -1, length: 0 };
  for (const term of terms) {
    const hit = fuzzyTerm(term, normalizedText);
    if (hit.score < MULTI_TERM_MIN_TERM_SCORE) return null;
    total += hit.score;
    if (hit.score > best.score) best = hit;
  }
  const score = total / terms.length;
  return score > 0 ? { score, index: best.index, length: best.length } : null;
}

function compileRegex(query, flags) {
  const source = String(query);
  if (source.length > MAX_QUERY_LENGTH) throw new Error('query is longer than ' + MAX_QUERY_LENGTH + ' characters');
  const rawFlags = flags === undefined || flags === null || flags === '' ? DEFAULT_REGEX_FLAGS : String(flags);
  if (!REGEX_FLAGS.test(rawFlags)) throw new Error('regex_flags may contain only i, m, s and u');
  if (new Set(charsOf(rawFlags)).size !== charsOf(rawFlags).length) throw new Error('regex_flags must not repeat a flag');
  if (UNSAFE_REGEX.test(source)) throw new Error('query looks like a nested-quantifier regex; simplify it');
  try {
    return new RegExp(source, rawFlags);
  } catch (error) {
    throw new Error('query is not a valid regular expression: ' + (error && error.message ? error.message : String(error)));
  }
}

/**
 * Compile one query into a matcher.
 * @returns {null | (text: string, id: string) => null | {score: number, index: number, length: number, mode: string, field: 'text'|'id'}}
 */
export function createSearchMatcher(options = {}) {
  const rawQuery = typeof options.query === 'string' ? options.query.trim() : '';
  if (rawQuery === '') return null;
  const mode = options.mode === undefined || options.mode === null || options.mode === '' ? 'substring' : String(options.mode);
  if (!SEARCH_MODES.includes(mode)) throw new Error('query_mode must be one of: ' + SEARCH_MODES.join(', '));
  if (rawQuery.length > (mode === 'fuzzy' ? MAX_FUZZY_QUERY_LENGTH : MAX_QUERY_LENGTH)) {
    throw new Error('query is too long for ' + mode + ' mode');
  }
  if (mode === 'substring') {
    const needle = normalize(rawQuery);
    return (text, id) => {
      const lower = normalize(text);
      const index = lower.indexOf(needle);
      if (index >= 0) return { score: 1, index, length: needle.length, mode, field: 'text' };
      if (normalize(id).includes(needle)) return { score: 1, index: -1, length: 0, mode, field: 'id' };
      return null;
    };
  }
  if (mode === 'regex') {
    const regex = compileRegex(rawQuery, options.regex_flags);
    return (text, id) => {
      const match = regex.exec(text);
      if (match !== null) return { score: 1, index: match.index, length: match[0].length, mode, field: 'text' };
      if (regex.exec(id) !== null) return { score: 1, index: -1, length: 0, mode, field: 'id' };
      return null;
    };
  }
  const minScoreRaw = options.min_score === undefined || options.min_score === null || options.min_score === '' ? DEFAULT_FUZZY_MIN_SCORE : Number(options.min_score);
  if (!Number.isFinite(minScoreRaw) || minScoreRaw < 0 || minScoreRaw > 1) throw new Error('min_score must be between 0 and 1');
  const minScore = minScoreRaw;
  const queryLower = normalize(rawQuery);
  return (text, id) => {
    if (normalize(id).includes(queryLower)) return { score: 1, index: -1, length: 0, mode, field: 'id' };
    const hit = fuzzyMatch(rawQuery, text);
    if (hit === null || hit.score < minScore) return null;
    return { ...hit, mode, field: 'text' };
  };
}
