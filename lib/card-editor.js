// dsh-markji-bridge: a small stateful card editor.
//
// An agent drafts a card the way a person types: append text, select a literal
// string and apply a style, mark a cloze, insert media, then preview/save.  The
// blocks are compiled to Markji rich text only at preview/save time, so the draft
// never contains fragile hand-written tags.  All state is owned by lib/tools.js;
// this module only mutates a plain draft object and never touches the network.

import { compileCardSpec } from './card-syntax.js';

const STYLE_KEYS = ['bold', 'underline', 'italic', 'strike', 'sup', 'sub', 'color', 'background', 'link'];
const MAX_HISTORY = 30;
const MASK_SCALE = 10000;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fail(message, hint) {
  const error = new Error(message);
  error.code = 'editor_error';
  if (typeof hint === 'string' && hint !== '') error.hint = hint;
  throw error;
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

function requireText(value, name) {
  if (typeof value !== 'string' || value.trim() === '') fail(name + ' is required');
  return value;
}

function styleOf(run) {
  const out = {};
  for (const key of STYLE_KEYS) {
    if (run[key] !== undefined && run[key] !== false && run[key] !== '') out[key] = run[key];
  }
  return out;
}

function hasStyles(run) {
  return Object.keys(styleOf(run)).length > 0;
}

function runText(run) {
  if (typeof run.text === 'string') return run.text;
  if (typeof run.formula === 'string') return '[公式]';
  if (run.formula_parts !== undefined) return '[公式]';
  if (run.cards !== undefined) return run.label || '[卡片]';
  return '';
}

function paragraphText(block) {
  return (block.runs || []).map(runText).join('');
}

function blockText(block) {
  if (block.type === 'heading') return block.text + (block.subtitle ? ' / ' + block.subtitle : '');
  if (block.type === 'answer_line') return '---';
  if (block.type === 'paragraph') return paragraphText(block);
  if (block.type === 'image') return block.mask ? '[图片+遮罩]' : '[图片]';
  if (block.type === 'audio') return '[音频]' + (block.label ? ': ' + block.label : '');
  if (block.type === 'formula') return '[公式: ' + (block.latex === undefined ? 'parts' : block.latex) + ']';
  if (block.type === 'card_ref') return '[卡片: ' + (block.ids || []).join('-') + ']';
  if (block.type === 'choice') {
    return '[选择题]\n' + (block.options || []).map((option, index) => (block.correct.includes(index + 1) ? '* ' : '- ') + option).join('\n');
  }
  if (block.type === 'list') return (block.items || []).map((item) => '  '.repeat(Math.max(0, item.level - 1)) + '- ' + item.text).join('\n');
  return '';
}

function newParagraph(text) {
  return { type: 'paragraph', runs: [{ text }] };
}

function appendRunText(block, text) {
  if (text === '') return;
  const last = block.runs[block.runs.length - 1];
  if (last && typeof last.text === 'string' && Object.keys(styleOf(last)).length === 0 && last.formula === undefined && last.cards === undefined && last.clozeGroup === undefined) {
    last.text += text;
  } else {
    block.runs.push({ text });
  }
}

export function createDraft({ id, deck, chapter }) {
  return {
    id,
    deck,
    chapter,
    blocks: [],
    history: [],
    saved: false,
    card_id: null,
    created_at: new Date().toISOString(),
  };
}

export function snapshot(draft) {
  draft.history.push(clone(draft.blocks));
  if (draft.history.length > MAX_HISTORY) draft.history.shift();
}

export function undo(draft) {
  const previous = draft.history.pop();
  if (!previous) fail('nothing to undo');
  draft.blocks = previous;
  return true;
}

export function blockCount(draft) {
  return draft.blocks.length;
}

export function typeText(draft, text) {
  const source = normalizeNewlines(requireText(text, 'text'));
  const lines = source.split('\n');
  let first = true;
  for (const line of lines) {
    if (line === '---') {
      addAnswerLine(draft);
      first = true;
      continue;
    }
    if (line.trim() === '') {
      const last = draft.blocks[draft.blocks.length - 1];
      if (last && last.type === 'paragraph') appendRunText(last, '\n');
      continue;
    }
    if (first) {
      const last = draft.blocks[draft.blocks.length - 1];
      if (last && last.type === 'paragraph') appendRunText(last, line);
      else draft.blocks.push(newParagraph(line));
    } else {
      draft.blocks.push(newParagraph(line));
    }
    first = false;
  }
}

export function addParagraph(draft, text) {
  const value = requireText(text, 'text');
  draft.blocks.push(newParagraph(normalizeNewlines(value)));
}

export function addHeading(draft, text, subtitle) {
  const value = requireText(text, 'text');
  const block = { type: 'heading', text: normalizeNewlines(value) };
  if (subtitle !== undefined && subtitle !== null && String(subtitle).trim() !== '') block.subtitle = String(subtitle).trim();
  draft.blocks.push(block);
}

export function addAnswerLine(draft) {
  if (draft.blocks.length === 0) fail('an answer line cannot be the first block', 'type the question first');
  if (draft.blocks[draft.blocks.length - 1].type === 'answer_line') fail('two answer lines in a row would create an empty page');
  draft.blocks.push({ type: 'answer_line' });
}

function textRunOffsets(block) {
  const map = [];
  let offset = 0;
  for (let index = 0; index < block.runs.length; index += 1) {
    const run = block.runs[index];
    if (typeof run.text !== 'string') continue;
    map.push({ index, start: offset, end: offset + run.text.length });
    offset += run.text.length;
  }
  return { map, length: offset };
}

function findRange(draft, target, occurrence) {
  const wanted = requireText(target, 'target');
  const nth = occurrence === undefined ? 1 : Number(occurrence);
  if (!Number.isInteger(nth) || nth < 1) fail('occurrence must be a positive integer');
  let seen = 0;
  for (let blockIndex = 0; blockIndex < draft.blocks.length; blockIndex += 1) {
    const block = draft.blocks[blockIndex];
    if (block.type !== 'paragraph') continue;
    const text = paragraphText(block);
    let from = 0;
    while (from <= text.length) {
      const at = text.indexOf(wanted, from);
      if (at < 0) break;
      seen += 1;
      if (seen === nth) return { blockIndex, start: at, end: at + wanted.length, target: wanted };
      from = at + 1;
    }
  }
  fail('target text not found: ' + JSON.stringify(wanted), 'call preview or status to see the current text; target must be inside one paragraph');
}

function mapRunsInRange(runs, start, end, apply) {
  let position = 0;
  const out = [];
  for (const run of runs) {
    if (typeof run.text !== 'string') {
      out.push(clone(run));
      continue;
    }
    const begin = Math.max(start, position);
    const finish = Math.min(end, position + run.text.length);
    if (begin >= finish) {
      out.push(clone(run));
    } else {
      if (begin > position) out.push({ ...clone(run), text: run.text.slice(0, begin - position) });
      const selected = { ...clone(run), text: run.text.slice(begin - position, finish - position) };
      apply(selected);
      out.push(selected);
      if (finish < position + run.text.length) out.push({ ...clone(run), text: run.text.slice(finish - position) });
    }
    position += run.text.length;
  }
  return out;
}

export function formatSelection(draft, { target, occurrence, style, value }) {
  const range = findRange(draft, target, occurrence);
  const block = draft.blocks[range.blockIndex];
  if (style === 'clear') {
    block.runs = mapRunsInRange(block.runs, range.start, range.end, (run) => {
      for (const key of STYLE_KEYS) delete run[key];
      delete run.clozeGroup;
    });
    return { ...range, style };
  }
  if (!STYLE_KEYS.includes(style)) fail('unknown style: ' + String(style), 'use bold, underline, italic, strike, sup, sub, color, background, link, or clear');
  if (style === 'color' || style === 'background') {
    const color = String(value === undefined ? '' : value).trim().replace(/^#/, '').toLowerCase();
    if (!/^[0-9a-f]{6}$/.test(color)) fail(style + ' needs six hex digits, e.g. "ff2600"');
    block.runs = mapRunsInRange(block.runs, range.start, range.end, (run) => { run[style] = color; });
  } else if (style === 'link') {
    const url = String(value === undefined ? '' : value).trim();
    if (!/^https?:\/\//i.test(url)) fail('link needs an http:// or https:// URL');
    block.runs = mapRunsInRange(block.runs, range.start, range.end, (run) => { run.link = url; });
  } else {
    block.runs = mapRunsInRange(block.runs, range.start, range.end, (run) => { run[style] = true; });
  }
  return { ...range, style, value: value === undefined ? null : value };
}

export function applyCloze(draft, { target, occurrence, group }) {
  const range = findRange(draft, target, occurrence);
  const block = draft.blocks[range.blockIndex];
  let maxGroup = 0;
  for (const candidate of draft.blocks) {
    if (candidate.type !== 'paragraph') continue;
    for (const run of candidate.runs) if (Number.isInteger(run.clozeGroup)) maxGroup = Math.max(maxGroup, run.clozeGroup);
  }
  let actual;
  if (group === undefined || group === null || group === '') actual = maxGroup + 1;
  else {
    actual = Number(group);
    if (!Number.isInteger(actual) || actual < 1) fail('group must be a positive integer');
  }
  let styled = false;
  let position = 0;
  for (const run of block.runs) {
    if (typeof run.text !== 'string') continue;
    const begin = Math.max(range.start, position);
    const finish = Math.min(range.end, position + run.text.length);
    if (begin < finish && hasStyles(run)) styled = true;
    position += run.text.length;
  }
  if (styled) fail('selected text already has a style; Markji does not allow styles inside a normal cloze', 'use format style=clear first, or put the style outside the cloze');
  block.runs = mapRunsInRange(block.runs, range.start, range.end, (run) => { run.clozeGroup = actual; });
  return { ...range, group: actual };
}

export function addInlineFormula(draft, latex) {
  let run;
  if (Array.isArray(latex)) run = { formula_parts: clone(latex) };
  else run = { formula: normalizeNewlines(requireText(latex, 'latex')) };
  const last = draft.blocks[draft.blocks.length - 1];
  if (last && last.type === 'paragraph') last.runs.push(run);
  else draft.blocks.push({ type: 'paragraph', runs: [run] });
}

export function addFormulaBlock(draft, latex) {
  const block = Array.isArray(latex) ? { type: 'formula', parts: clone(latex) } : { type: 'formula', latex: normalizeNewlines(requireText(latex, 'latex')) };
  draft.blocks.push(block);
}

export function addCardRef(draft, ids, label) {
  if (!Array.isArray(ids) || ids.length === 0) fail('ids must contain at least one root_id');
  const block = { type: 'card_ref', ids: ids.map(String).map((id) => id.trim()).filter(Boolean) };
  if (label !== undefined && label !== null && String(label).trim() !== '') block.label = String(label).trim();
  draft.blocks.push(block);
}

export function addImage(draft, { file, mask }) {
  const block = { type: 'image', file: requireText(file, 'file') };
  if (mask !== undefined && mask !== null && String(mask).trim() !== '') block.mask = String(mask).trim();
  draft.blocks.push(block);
}

export function addAudio(draft, { file, label, play }) {
  const block = { type: 'audio', file: requireText(file, 'file'), play: play || 'auto' };
  if (label !== undefined && label !== null && String(label).trim() !== '') block.label = String(label);
  draft.blocks.push(block);
}

export function addChoice(draft, { options, correct, fixed }) {
  if (!Array.isArray(options) || options.length === 0) fail('options must be a non-empty array');
  const texts = options.map((option, index) => {
    if (typeof option === 'string') return requireText(option, 'options[' + index + ']');
    if (isObject(option) && typeof option.text === 'string' && option.text.trim() !== '') return option.text;
    fail('options[' + index + '] must be a non-empty string or {text, correct?}');
  });
  const correctness = new Set();
  if (correct !== undefined && correct !== null && correct !== '') {
    const values = Array.isArray(correct) ? correct : [correct];
    for (const value of values) {
      const number = Number(value);
      if (!Number.isInteger(number) || number < 1 || number > texts.length) fail('correct must be a 1-based option index within options');
      correctness.add(number);
    }
  }
  options.forEach((option, index) => {
    if (isObject(option) && option.correct === true) correctness.add(index + 1);
  });
  if (correctness.size === 0) fail('mark at least one option correct with correct or option.correct=true');
  const multiple = correctness.size > 1;
  draft.blocks.push({
    type: 'choice',
    options: texts,
    correct: [...correctness].sort((a, b) => a - b),
    multiple,
    fixed: fixed === true,
  });
}

export function addList(draft, { items }) {
  if (!Array.isArray(items) || items.length === 0) fail('items must be a non-empty array');
  const normalized = items.map((item, index) => {
    if (typeof item === 'string') return { text: requireText(item, 'items[' + index + ']'), level: 1 };
    if (isObject(item) && typeof item.text === 'string' && item.text.trim() !== '') {
      const level = item.level === undefined ? 1 : Number(item.level);
      if (!Number.isInteger(level) || level < 1 || level > 9) fail('items[' + index + '].level must be 1-9');
      return { text: item.text, level };
    }
    fail('items[' + index + '] must be a string or {text, level?}');
  });
  draft.blocks.push({ type: 'list', items: normalized });
}

export function plainTextOfDraft(draft) {
  return draft.blocks.map(blockText).join('\n');
}

export function viewDraft(draft) {
  return {
    draft_id: draft.id,
    deck: draft.deck,
    chapter: draft.chapter,
    saved: draft.saved,
    card_id: draft.card_id,
    block_count: draft.blocks.length,
    can_undo: draft.history.length > 0,
    text: plainTextOfDraft(draft),
    blocks: draft.blocks.map((block, index) => ({ index, type: block.type, text: blockText(block) })),
  };
}

function runsToSpec(runs, path) {
  const out = [];
  for (let index = 0; index < runs.length; index += 1) {
    const run = runs[index];
    const runPath = path + '[' + index + ']';
    if (typeof run.formula === 'string') {
      out.push({ formula: run.formula });
      continue;
    }
    if (run.formula_parts !== undefined) {
      out.push({ formula_parts: run.formula_parts });
      continue;
    }
    if (run.cards !== undefined) {
      out.push({ cards: run.cards, ...(run.label === undefined ? {} : { label: run.label }) });
      continue;
    }
    if (typeof run.text !== 'string' || run.text === '') continue;
    if (run.clozeGroup !== undefined) {
      if (hasStyles(run)) fail('cloze text cannot also have styles; clear the style first');
      out.push({ cloze: run.text, group: run.clozeGroup });
      continue;
    }
    out.push({ text: run.text, ...styleOf(run) });
  }
  if (out.length === 0) fail(path + ' is empty');
  return out;
}

function blockToSpec(block, path) {
  if (block.type === 'paragraph') return { type: 'paragraph', runs: runsToSpec(block.runs, path + '.runs') };
  if (block.type === 'heading') return { type: 'heading', text: block.text, ...(block.subtitle === undefined ? {} : { subtitle: block.subtitle }) };
  if (block.type === 'image') return { type: 'image', file: block.file, ...(block.mask === undefined ? {} : { mask: block.mask }) };
  if (block.type === 'audio') return { type: 'audio', file: block.file, ...(block.label === undefined ? {} : { label: block.label }), play: block.play };
  if (block.type === 'formula') return { type: 'formula', ...(block.parts === undefined ? { latex: block.latex } : { parts: block.parts }) };
  if (block.type === 'card_ref') return { type: 'card_ref', ids: block.ids, ...(block.label === undefined ? {} : { label: block.label }) };
  if (block.type === 'choice') return { type: 'choice', options: block.options, correct: block.correct, multiple: block.multiple, fixed: block.fixed };
  if (block.type === 'list') return { type: 'list', items: block.items };
  fail('unknown editor block type: ' + String(block.type));
}

export function compileDraft(draft) {
  const pages = [[]];
  for (let index = 0; index < draft.blocks.length; index += 1) {
    const block = draft.blocks[index];
    if (block.type === 'answer_line') {
      if (pages[pages.length - 1].length === 0) fail('answer line would create an empty page');
      pages.push([]);
      continue;
    }
    pages[pages.length - 1].push(blockToSpec(block, 'blocks[' + index + ']'));
  }
  while (pages.length > 1 && pages[pages.length - 1].length === 0) pages.pop();
  if (pages.length === 1 && pages[0].length === 0) fail('draft is empty; type something first');
  const result = compileCardSpec({ pages });
  return { ...result, text: plainTextOfDraft(draft) };
}

function normalizeRect(rect, path) {
  if (!isObject(rect)) fail(path + ' must be an object');
  let x1;
  let y1;
  let x2;
  let y2;
  if (rect.x1 !== undefined || rect.x2 !== undefined) {
    x1 = Number(rect.x1);
    y1 = Number(rect.y1);
    x2 = Number(rect.x2);
    y2 = Number(rect.y2);
  } else if (rect.left !== undefined && rect.top !== undefined && rect.width !== undefined && rect.height !== undefined) {
    x1 = Number(rect.left);
    y1 = Number(rect.top);
    x2 = x1 + Number(rect.width);
    y2 = y1 + Number(rect.height);
  } else if (rect.left !== undefined && rect.top !== undefined && rect.right !== undefined && rect.bottom !== undefined) {
    x1 = Number(rect.left);
    y1 = Number(rect.top);
    x2 = Number(rect.right);
    y2 = Number(rect.bottom);
  } else {
    fail(path + ' needs x1,y1,x2,y2 or left,top,width,height or left,top,right,bottom');
  }
  if (![x1, y1, x2, y2].every(Number.isFinite)) fail(path + ' coordinates must be finite numbers');
  if (x2 <= x1 || y2 <= y1) fail(path + ' needs x2 > x1 and y2 > y1');
  return { x1, y1, x2, y2 };
}

export function buildMask(rects, width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isInteger(w) || w <= 0 || !Number.isInteger(h) || h <= 0) fail('width and height must be positive pixel integers');
  if (!Array.isArray(rects) || rects.length === 0) fail('mask_rects must be a non-empty array');
  return rects.map((rect, index) => {
    const normalized = normalizeRect(rect, 'mask_rects[' + index + ']');
    if (normalized.x1 < 0 || normalized.y1 < 0 || normalized.x2 > w || normalized.y2 > h) fail('mask_rects[' + index + '] is outside the ' + w + 'x' + h + ' image');
    const left = Math.round(normalized.x1 / w * MASK_SCALE);
    const top = Math.round(normalized.y1 / h * MASK_SCALE);
    const boxWidth = Math.round((normalized.x2 - normalized.x1) / w * MASK_SCALE);
    const boxHeight = Math.round((normalized.y2 - normalized.y1) / h * MASK_SCALE);
    if (boxWidth <= 0 || boxHeight <= 0) fail('mask_rects[' + index + '] is too small after normalization');
    return { width: boxWidth, height: boxHeight, top, left, index: index + 1, type: 'rect' };
  });
}

export function parseImageSize(bytes) {
  if (!bytes || typeof bytes.length !== 'number' || bytes.length < 10) return null;
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  // PNG: IHDR width/height at 16/20 (big endian).
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }
  // GIF: logical screen width/height little endian.
  if (buf.length >= 10 && buf.toString('ascii', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
  }
  // JPEG: scan the marker chain for SOFn.
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let cursor = 2;
    while (cursor + 9 < buf.length) {
      if (buf[cursor] !== 0xff) { cursor += 1; continue; }
      let marker = buf[cursor + 1];
      while (marker === 0xff && cursor + 2 < buf.length) { cursor += 1; marker = buf[cursor + 1]; }
      if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { cursor += 2; continue; }
      const length = buf.readUInt16BE(cursor + 2);
      if (length < 2) return null;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: buf.readUInt16BE(cursor + 7), height: buf.readUInt16BE(cursor + 5), format: 'jpeg' };
      }
      cursor += 2 + length;
    }
    return null;
  }
  // WebP: VP8X has 24-bit canvas width/height minus one; VP8/VP8L are less common.
  if (buf.length >= 30 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    const chunk = buf.toString('ascii', 12, 16);
    if (chunk === 'VP8X') {
      const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
      const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
      return { width, height, format: 'webp' };
    }
    if (chunk === 'VP8 ') {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
    }
    if (chunk === 'VP8L') {
      const bits = buf.readUInt32LE(21);
      return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff), format: 'webp' };
    }
  }
  return null;
}
