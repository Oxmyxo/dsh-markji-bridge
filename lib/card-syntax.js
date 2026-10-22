// dsh-markji-bridge: compile a small, explicit card spec into Markji rich text
// and validate hand-written Markji syntax before it is queued.
//
// The compiler is deliberately conservative: it covers the syntax documented in
// the Markji card-syntax guide, escapes user text by default, and rejects media
// ids / URLs that look like paths or placeholders.  The validator is advisory for
// raw content; generated content is validated before it is written.

const CONTENT_MAX = 100000;
const TAG_NAMES = new Set(['T', 'P', 'F', 'Choice', 'Pic', 'Audio', 'Card', 'E']);
const INLINE_TAGS = new Set(['T', 'F', 'Audio', 'Card']);
const BLOCK_TAGS = new Set(['P', 'Choice', 'Pic']);
const STYLE_FLAGS = new Set(['B', 'U', 'I', 'D', 'up', 'down']);
const LIST_LEVELS = 9;
const MAX_CARD_REFS = 5;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeNewlines(text) {
  return String(text).replace(/\r\n?/g, '\n');
}

function fail(path, message, hint) {
  const error = new Error(message);
  error.name = 'CardSyntaxError';
  error.code = 'invalid_card_spec';
  error.path = path;
  if (typeof hint === 'string' && hint !== '') error.hint = hint;
  throw error;
}

function requireObject(value, path) {
  if (!isObject(value)) fail(path, 'must be an object');
  return value;
}

function requireString(value, path) {
  if (typeof value !== 'string') fail(path, 'must be a string');
  return value;
}

function requireNonEmpty(value, path) {
  const text = requireString(value, path);
  if (text.trim() === '') fail(path, 'must not be empty');
  return text;
}

function requireOneLine(value, path) {
  const text = requireString(value, path);
  if (text.includes('\n')) fail(path, 'must be a single line');
  return text;
}

function requireInteger(value, path, min, max) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(number) || number < min || (max !== undefined && number > max)) {
    fail(path, 'must be an integer from ' + min + (max === undefined ? ' up' : ' to ' + max));
  }
  return number;
}

export function escapeText(value) {
  const text = normalizeNewlines(value);
  return text.replace(/(?<!\\)\[/g, '\\[').replace(/(?<!\\)\]/g, '\\]');
}

function escapeInline(value, path) {
  const text = requireOneLine(value, path);
  return escapeText(text);
}

function hasUnescapedBrackets(text) {
  return /(?<!\\)[\[\]]/.test(text);
}

function encodeUrl(value, path) {
  const text = requireNonEmpty(value, path).trim();
  if (!/^https?:\/\//i.test(text)) fail(path, 'must start with http:// or https://');
  if (/"/.test(text)) fail(path, 'must not contain an unencoded double quote');
  return text.replace(/ /g, '%20').replace(/\t/g, '%20').replace(/#/g, '%23').replace(/,/g, '%2C');
}

function checkFileId(value, path) {
  const id = requireNonEmpty(value, path).trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(id) || id.includes('/')) {
    fail(path, 'must be a real Markji file.id (letters, digits, _, . or -), not a filename or URL');
  }
  return id;
}

function checkRootIds(value, path) {
  const ids = Array.isArray(value) ? value : [value];
  if (ids.length === 0) fail(path, 'must contain at least one root_id');
  if (ids.length > MAX_CARD_REFS) fail(path, 'can reference at most ' + MAX_CARD_REFS + ' cards');
  const out = [];
  for (let index = 0; index < ids.length; index += 1) {
    const id = requireNonEmpty(ids[index], path + '[' + index + ']').trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9_]*$/.test(id)) {
      fail(path + '[' + index + ']', 'must be a real Markji root_id (letters, digits or _), not a card/deck/file id');
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

function checkColor(value, path) {
  const text = requireNonEmpty(value, path).trim().replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{6}$/.test(text)) fail(path, 'must be six hex digits without #, e.g. ff2600');
  return text;
}

function checkLatex(value, path, inline) {
  const latex = requireNonEmpty(value, path);
  if (latex.includes('$')) fail(path, 'must not include $, $$, \\( or \\[ delimiters; Markji adds the formula boundary');
  if (inline && latex.includes('\n')) fail(path, 'inline formulas must be a single line');
  if (/\\[()[\]]/.test(latex)) fail(path, 'must not include \\( \\) \\[ \\] delimiters; write the LaTeX directly');
  return latex;
}

function nextClozeGroup(ctx) {
  ctx.nextGroup += 1;
  return ctx.nextGroup;
}

function readGroup(value, path) {
  if (value === undefined || value === null) return undefined;
  return requireInteger(value, path, 1, 999999);
}

function compileCloze(value, group, ctx, path, latex) {
  const text = requireNonEmpty(value, path);
  if (!latex && text.includes('\n')) fail(path, 'cloze text must be a single line');
  const actual = group === undefined ? nextClozeGroup(ctx) : readGroup(group, path);
  if (actual > ctx.nextGroup) ctx.nextGroup = actual;
  const body = latex ? text : escapeText(text);
  return '[F#' + actual + '#' + body + ']';
}

function compileFormulaParts(value, ctx, path, inline) {
  if (typeof value === 'string') return checkLatex(value, path, inline);
  if (Array.isArray(value)) {
    if (value.length === 0) fail(path, 'must not be empty');
    let out = '';
    for (let index = 0; index < value.length; index += 1) {
      const part = value[index];
      const partPath = path + '[' + index + ']';
      if (typeof part === 'string') out += checkLatex(part, partPath, inline);
      else if (isObject(part) && typeof part.cloze === 'string') {
        out += compileCloze(part.cloze, part.group, ctx, partPath, true);
      } else if (isObject(part) && typeof part.latex === 'string') out += checkLatex(part.latex, partPath, inline);
      else fail(partPath, 'must be a LaTeX string or {cloze, group?}');
    }
    return out;
  }
  if (isObject(value) && typeof value.latex === 'string') return checkLatex(value.latex, path, inline);
  fail(path, 'must be a LaTeX string or an array of LaTeX strings / cloze parts');
}

function compileCardReference(ids, label, path) {
  const rootIds = checkRootIds(ids, path + '.ids');
  const text = label === undefined || label === null ? '参见相关卡片' : escapeInline(label, path + '.label');
  return '[Card#ID/' + rootIds.join('-') + '#' + text + ']';
}

function compileStyledText(run, path) {
  const text = requireNonEmpty(run.text, path + '.text');
  const styles = [];
  if (run.bold === true) styles.push('B');
  if (run.underline === true) styles.push('U');
  if (run.italic === true) styles.push('I');
  if (run.strike === true) styles.push('D');
  if (run.sup === true) styles.push('up');
  if (run.sub === true) styles.push('down');
  if (run.sup === true && run.sub === true) fail(path, 'sup and sub cannot both be true');
  if (run.color !== undefined) styles.push('!' + checkColor(run.color, path + '.color'));
  if (run.background !== undefined) styles.push('!!' + checkColor(run.background, path + '.background'));
  if (run.link !== undefined) styles.push('link/"' + encodeUrl(run.link, path + '.link') + '"');
  const body = escapeInline(text, path + '.text');
  if (styles.length === 0) return body;
  return '[T#' + styles.join(',') + '#' + body + ']';
}

function compileRun(run, ctx, path, kind) {
  if (typeof run === 'string') return escapeInline(run, path);
  if (!isObject(run)) fail(path, 'must be a string or an object');
  const hasFormula = run.formula !== undefined || run.formula_parts !== undefined;
  const hasCloze = run.cloze !== undefined;
  const hasCards = run.cards !== undefined || run.card !== undefined;
  const hasUrl = run.url !== undefined;
  const hasText = run.text !== undefined;
  const count = [hasFormula, hasCloze, hasCards, hasUrl, hasText].filter(Boolean).length;
  if (count === 0 && run.link === undefined) fail(path, 'must contain text, formula, cloze, link, or cards');
  if (hasFormula) return '[E##' + compileFormulaParts(run.formula_parts !== undefined ? run.formula_parts : run.formula, ctx, path + '.formula', true) + ']';
  if (hasCloze) {
    if (kind === 'choice') fail(path, 'choice options cannot contain cloze; put the cloze in the question or answer');
    return compileCloze(run.cloze, run.group, ctx, path + '.cloze', false);
  }
  if (hasCards) {
    if (kind === 'choice') fail(path, 'choice options cannot contain card references');
    return compileCardReference(run.cards !== undefined ? run.cards : run.card, run.label, path);
  }
  if (hasUrl) {
    const label = run.label !== undefined ? run.label : run.text;
    if (label === undefined) fail(path, 'a link needs a label (or text)');
    return '[T#link/"' + encodeUrl(run.url, path + '.url') + '"#' + escapeInline(label, path + '.label') + ']';
  }
  if (run.link !== undefined && run.text === undefined && run.label !== undefined) {
    return '[T#link/"' + encodeUrl(run.link, path + '.link') + '"#' + escapeInline(run.label, path + '.label') + ']';
  }
  if (!hasText && run.link !== undefined) {
    return '[T#link/"' + encodeUrl(run.link, path + '.link') + '"#' + escapeInline(run.link, path + '.link') + ']';
  }
  return compileStyledText(run, path);
}

function compileRuns(runs, ctx, path, kind) {
  if (typeof runs === 'string') return escapeText(runs);
  if (!Array.isArray(runs)) fail(path, 'must be a string or an array of inline runs');
  let out = '';
  for (let index = 0; index < runs.length; index += 1) out += compileRun(runs[index], ctx, path + '[' + index + ']', kind);
  return out;
}

function compileParagraph(block, ctx, path) {
  const text = block.runs !== undefined ? compileRuns(block.runs, ctx, path + '.runs', 'paragraph') : escapeText(requireString(block.text, path + '.text'));
  if (text.trim() === '') fail(path, 'paragraph is empty');
  if (/\n[ \t]*---[ \t]*(?:\n|$)/.test(text)) fail(path, 'a paragraph cannot contain an answer line (---); use another page instead');
  const params = [];
  if (block.indent !== undefined) params.push('I' + requireInteger(block.indent, path + '.indent', 1, LIST_LEVELS));
  if (block.align !== undefined) {
    if (!['center', 'left', 'right'].includes(block.align)) fail(path + '.align', 'must be center, left, or right');
    params.push(block.align);
  }
  return params.length === 0 ? text : '[P#' + params.join(',') + '#' + text + ']';
}

function compileHeading(block, path) {
  if (block.runs !== undefined) fail(path, 'heading uses text, not runs');
  const text = escapeInline(requireNonEmpty(block.text, path + '.text'), path + '.text');
  let out = '[P#H1,center#[T#B#' + text + ']]';
  if (block.subtitle !== undefined && String(block.subtitle).trim() !== '') {
    out += '\n[P#center#' + escapeInline(block.subtitle, path + '.subtitle') + ']';
  }
  return out;
}

function compileList(block, ctx, path) {
  if (!Array.isArray(block.items) || block.items.length === 0) fail(path + '.items', 'must be a non-empty array');
  const out = [];
  for (let index = 0; index < block.items.length; index += 1) {
    const item = block.items[index];
    const itemPath = path + '.items[' + index + ']';
    let content;
    let level = 1;
    if (typeof item === 'string') content = escapeInline(item, itemPath);
    else if (isObject(item)) {
      level = item.level === undefined ? 1 : requireInteger(item.level, itemPath + '.level', 1, LIST_LEVELS);
      content = item.runs !== undefined ? compileRuns(item.runs, ctx, itemPath + '.runs', 'list') : escapeInline(item.text, itemPath + '.text');
    } else fail(itemPath, 'must be a string or {text|runs, level?}');
    if (content.trim() === '') fail(itemPath, 'list item is empty');
    if (content.includes('\n')) fail(itemPath, 'list items must be a single line');
    out.push('[P#L' + (level > 1 ? ',I' + level : '') + '#' + content + ']');
  }
  return out.join('\n');
}

function compileChoiceOption(option, ctx, path) {
  if (typeof option === 'string') return escapeInline(option, path);
  if (!isObject(option)) fail(path, 'must be a string or {text|runs|formula, correct?}');
  if (option.formula !== undefined || option.formula_parts !== undefined) {
    return '[E##' + compileFormulaParts(option.formula_parts !== undefined ? option.formula_parts : option.formula, ctx, path + '.formula', true) + ']';
  }
  const content = option.runs !== undefined ? compileRuns(option.runs, ctx, path + '.runs', 'choice') : escapeInline(option.text, path + '.text');
  if (content.trim() === '') fail(path, 'choice option is empty');
  if (content.includes('\n')) fail(path, 'choice options must be a single line');
  if (/\[(?:F|Audio|Card|Pic|P|Choice)#/.test(content)) fail(path, 'choice options may only contain text styles and formulas');
  return content;
}

function compileChoice(block, ctx, path) {
  if (!Array.isArray(block.options) || block.options.length === 0) fail(path + '.options', 'must be a non-empty array');
  const correct = new Set();
  if (block.correct !== undefined) {
    const values = Array.isArray(block.correct) ? block.correct : [block.correct];
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index];
      const number = requireInteger(value, path + '.correct[' + index + ']', 1, block.options.length);
      correct.add(number - 1);
    }
  }
  block.options.forEach((option, index) => {
    if (isObject(option) && option.correct === true) correct.add(index);
  });
  if (correct.size === 0) fail(path, 'mark at least one option correct (correct: 1-based index or option.correct=true)');
  const multiple = correct.size > 1;
  if (block.multiple !== undefined && Boolean(block.multiple) !== multiple) {
    fail(path + '.multiple', multiple ? 'must be true when more than one option is correct' : 'must be false when only one option is correct');
  }
  const fixed = block.fixed === true;
  const params = [fixed ? 'fixed' : null, multiple ? 'multi' : null].filter(Boolean).join(',');
  const lines = block.options.map((option, index) => (correct.has(index) ? '* ' : '- ') + compileChoiceOption(option, ctx, path + '.options[' + index + ']'));
  return '[Choice#' + params + '#\n' + lines.join('\n') + '\n]';
}

function compileImage(block, path) {
  const file = checkFileId(block.file, path + '.file');
  if (block.mask !== undefined && block.mask !== null && String(block.mask).trim() !== '') {
    const mask = checkFileId(block.mask, path + '.mask');
    return '[Pic#ID/' + file + ',MID/' + mask + '#]';
  }
  return '[Pic#ID/' + file + '#]';
}

function compileAudio(block, path) {
  const file = checkFileId(block.file, path + '.file');
  const play = block.play === undefined ? 'auto' : block.play;
  if (!['auto', 'manual', 'default'].includes(play)) fail(path + '.play', 'must be auto, manual, or default');
  const mode = play === 'auto' ? 'A' : play === 'manual' ? 'M' : 'D';
  const label = block.label === undefined || block.label === null ? '' : escapeInline(block.label, path + '.label');
  return '[Audio#' + mode + ',ID/' + file + '#' + label + ']';
}

function compileFormula(block, ctx, path) {
  const content = block.parts !== undefined ? compileFormulaParts(block.parts, ctx, path + '.parts', false) : checkLatex(block.latex, path + '.latex', false);
  if (content.trim() === '') fail(path, 'formula is empty');
  return '[E##' + content + ']';
}

function compileBlock(block, ctx, path) {
  if (typeof block === 'string') return escapeText(block);
  if (!isObject(block)) fail(path, 'must be a block object or a string');
  let type = block.type;
  if (type === undefined && block.text !== undefined) type = 'paragraph';
  if (type === 'text') type = 'paragraph';
  if (type === undefined) fail(path, 'block.type is required (heading, paragraph, list, choice, image, audio, formula, card_ref, link, raw)');
  switch (type) {
    case 'heading':
      return compileHeading(block, path);
    case 'paragraph':
      return compileParagraph(block, ctx, path);
    case 'list':
      return compileList(block, ctx, path);
    case 'choice':
      return compileChoice(block, ctx, path);
    case 'image':
      return compileImage(block, path);
    case 'audio':
      return compileAudio(block, path);
    case 'formula':
      return compileFormula(block, ctx, path);
    case 'card_ref':
      return compileCardReference(block.ids, block.label, path);
    case 'link':
      return '[T#link/"' + encodeUrl(block.url, path + '.url') + '"#' + escapeInline(block.label, path + '.label') + ']';
    case 'raw':
      if (typeof block.content !== 'string' || block.content.trim() === '') fail(path + '.content', 'raw content must be a non-empty string');
      return normalizeNewlines(block.content).trim();
    default:
      fail(path + '.type', 'unknown block type ' + String(type));
  }
}

function compilePage(page, ctx, path) {
  let blocks = page;
  if (isObject(page) && Array.isArray(page.blocks)) blocks = page.blocks;
  if (!Array.isArray(blocks)) fail(path, 'must be an array of blocks, or {blocks: [...]}');
  const parts = [];
  for (let index = 0; index < blocks.length; index += 1) {
    const part = compileBlock(blocks[index], ctx, path + '[' + index + ']');
    if (typeof part === 'string' && part.trim() !== '') parts.push(part.trim());
  }
  if (parts.length === 0) fail(path, 'page is empty');
  return parts.join('\n');
}

export function compileSimpleCard(fields) {
  if (!isObject(fields)) fail('card', 'must be an object');
  const title = fields.title === undefined || fields.title === null ? '' : requireOneLine(fields.title, 'card.title');
  const front = fields.front === undefined || fields.front === null ? '' : normalizeNewlines(requireString(fields.front, 'card.front')).trim();
  const back = fields.back === undefined || fields.back === null ? '' : normalizeNewlines(requireString(fields.back, 'card.back')).trim();
  if (front === '' && title === '') fail('card.front', 'provide front or title');
  if (front === '' && back !== '') fail('card.front', 'provide front when back is set');
  const pages = [];
  const pieces = [];
  if (title !== '') pieces.push('[P#H1,center#[T#B#' + escapeInline(title, 'card.title') + ']]');
  if (front !== '') pieces.push(escapeText(front));
  if (pieces.length > 0) pages.push(pieces.join('\n'));
  if (back !== '') pages.push(escapeText(back));
  const content = pages.join('\n---\n');
  const validation = validateCardContent(content);
  if (validation.errors.length > 0) throw validation.errors[0];
  return { content, warnings: validation.warnings, stats: validation.stats };
}

export function compileCardSpec(spec) {
  const source = requireObject(spec, 'spec');
  let pages;
  if (Array.isArray(source.pages)) pages = source.pages;
  else if (Array.isArray(source.blocks)) pages = [source.blocks];
  else fail('spec', 'must contain pages (array of pages) or blocks (one page)');
  if (pages.length === 0) fail('spec.pages', 'must contain at least one page');
  const ctx = { nextGroup: 0 };
  const compiled = [];
  for (let index = 0; index < pages.length; index += 1) compiled.push(compilePage(pages[index], ctx, 'spec.pages[' + index + ']'));
  const content = compiled.join('\n---\n');
  if (content.length > CONTENT_MAX) fail('spec', 'compiled content is ' + content.length + ' characters, max ' + CONTENT_MAX);
  const validation = validateCardContent(content);
  if (validation.errors.length > 0) throw validation.errors[0];
  return { content, warnings: validation.warnings, stats: validation.stats };
}

function lineStarts(text) {
  const starts = [0];
  for (let index = 0; index < text.length; index += 1) if (text[index] === '\n') starts.push(index + 1);
  return starts;
}

function positionOf(starts, index) {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (starts[mid] <= index) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: index - starts[low] + 1 };
}

function issue(list, code, message, at, path, hint) {
  list.push({
    code,
    message,
    line: at.line,
    column: at.column,
    path: path || null,
    ...(hint === undefined ? {} : { hint }),
  });
}

function scanContent(content) {
  const errors = [];
  const warnings = [];
  const nodes = [];
  const starts = lineStarts(content);
  const at = (index) => positionOf(starts, index);
  let index = 0;

  function skipEscaped() {
    if (content[index] === '\\' && (content[index + 1] === '[' || content[index + 1] === ']')) {
      index += 2;
      return true;
    }
    return false;
  }

  function readHeader(open) {
    let cursor = open + 1;
    while (cursor < content.length && /[A-Za-z0-9]/.test(content[cursor])) cursor += 1;
    const name = content.slice(open + 1, cursor);
    if (name === '' || content[cursor] !== '#') {
      issue(errors, 'invalid_tag', 'literal [ must be escaped as \\[; this does not look like a tag', at(open), null, 'use \\[ and \\] for literal brackets');
      return null;
    }
    const nameEnd = cursor;
    cursor += 1;
    const paramsStart = cursor;
    while (cursor < content.length && content[cursor] !== '#' && content[cursor] !== ']' && content[cursor] !== '\n') cursor += 1;
    if (content[cursor] !== '#') {
      issue(errors, 'invalid_tag', 'tag ' + name + ' needs a second # (use ## for empty params)', at(open), null, 'example: [E##x+y] or [T#B#text]');
      return null;
    }
    return { name, params: content.slice(paramsStart, cursor), contentStart: cursor + 1, nameEnd };
  }

  function findLeafClose(start) {
    let cursor = start;
    while (cursor < content.length) {
      if (content[cursor] === '\\' && (content[cursor + 1] === '[' || content[cursor + 1] === ']')) {
        cursor += 2;
        continue;
      }
      if (content[cursor] === ']') return cursor;
      cursor += 1;
    }
    return -1;
  }

  function findFormulaClose(start) {
    let cursor = start;
    while (cursor < content.length) {
      if (content[cursor] === '\\' && (content[cursor + 1] === '[' || content[cursor + 1] === ']')) {
        cursor += 2;
        continue;
      }
      if (content.startsWith('[F#', cursor)) {
        const close = findLeafClose(cursor + 3);
        if (close < 0) return -1;
        cursor = close + 1;
        continue;
      }
      if (content[cursor] === ']') {
        const before = content.slice(Math.max(0, cursor - 6), cursor);
        if (before.endsWith('\\right') || before.endsWith('\\left')) {
          cursor += 1;
          continue;
        }
        return cursor;
      }
      cursor += 1;
    }
    return -1;
  }

  function parseSequence(cursor, stopAtClose) {
    const list = [];
    while (cursor < content.length) {
      index = cursor;
      if (skipEscaped()) {
        cursor = index;
        continue;
      }
      const ch = content[cursor];
      if (ch === ']') {
        if (stopAtClose) return { nodes: list, close: cursor };
        issue(errors, 'unexpected_bracket', 'unexpected ]; escape a literal ] as \\]', at(cursor), null);
        cursor += 1;
        continue;
      }
      if (ch !== '[') {
        cursor += 1;
        continue;
      }
      const header = readHeader(cursor);
      if (header === null) {
        const close = findLeafClose(cursor + 1);
        if (close < 0) {
          issue(errors, 'unclosed_bracket', 'unclosed [', at(cursor), null);
          return { nodes: list, close: -1 };
        }
        cursor = close + 1;
        continue;
      }
      const start = cursor;
      const contentStart = header.contentStart;
      if (header.name === 'E') {
        const close = findFormulaClose(contentStart);
        if (close < 0) {
          issue(errors, 'unclosed_bracket', 'unclosed E formula tag', at(start), null);
          return { nodes: list, close: -1 };
        }
        list.push({ name: header.name, params: header.params, content: content.slice(contentStart, close), start, end: close, children: [] });
        cursor = close + 1;
        continue;
      }
      if (header.name === 'P' || header.name === 'Choice') {
        const sub = parseSequence(contentStart, true);
        if (sub.close < 0) {
          issue(errors, 'unclosed_bracket', 'unclosed ' + header.name + ' tag', at(start), null);
          return { nodes: list, close: -1 };
        }
        list.push({ name: header.name, params: header.params, content: content.slice(contentStart, sub.close), start, end: sub.close, children: sub.nodes });
        cursor = sub.close + 1;
        continue;
      }
      const close = findLeafClose(contentStart);
      if (close < 0) {
        issue(errors, 'unclosed_bracket', 'unclosed ' + header.name + ' tag', at(start), null);
        return { nodes: list, close: -1 };
      }
      list.push({ name: header.name, params: header.params, content: content.slice(contentStart, close), start, end: close, children: [] });
      cursor = close + 1;
    }
    return { nodes: list, close: stopAtClose ? -1 : null };
  }

  const parsed = parseSequence(0, false);
  return { nodes: parsed.nodes, errors, warnings, starts };
}

function splitParams(params) {
  if (params === '') return [];
  return params.split(',');
}

function nodePosition(node, starts) {
  return positionOf(starts, node.start);
}

function validateText(node, starts, errors, warnings) {
  if (hasUnescapedBrackets(node.content)) {
    issue(errors, 'inline_nested', 'T content cannot contain other tags; merge styles into one T tag or escape brackets', nodePosition(node, starts), null);
  }
  const params = splitParams(node.params);
  if (params.length === 0) issue(errors, 'invalid_style', 'T needs at least one style, e.g. [T#B#text]', nodePosition(node, starts), null);
  const seen = new Set();
  for (const param of params) {
    if (STYLE_FLAGS.has(param) || param === 'up' || param === 'down') {
      if (seen.has(param)) issue(errors, 'duplicate_style', 'duplicate text style: ' + param, nodePosition(node, starts), null);
      seen.add(param);
    } else if (/^!![0-9a-fA-F]{6}$/.test(param)) {
      if ([...seen].some((value) => value.startsWith('!!'))) issue(errors, 'duplicate_style', 'more than one background color', nodePosition(node, starts), null);
      seen.add(param.toLowerCase());
    } else if (/^![0-9a-fA-F]{6}$/.test(param)) {
      if ([...seen].some((value) => value.startsWith('!') && !value.startsWith('!!'))) issue(errors, 'duplicate_style', 'more than one text color', nodePosition(node, starts), null);
      seen.add(param.toLowerCase());
    } else if (/^link\/".*"$/.test(param)) {
      if (seen.has('link')) issue(errors, 'duplicate_style', 'more than one link', nodePosition(node, starts), null);
      seen.add('link');
      const url = param.slice(6, -1);
      if (url === '') issue(errors, 'invalid_link', 'link URL is empty', nodePosition(node, starts), null);
      else if (/["\s#]/.test(url)) issue(errors, 'invalid_link', 'link URL contains an unencoded quote, space, or #', nodePosition(node, starts), null, 'encode # as %23, commas as %2C');
      else if (!/^https?:\/\//i.test(url)) warnings.push({ code: 'relative_link', message: 'link does not start with http:// or https://', line: nodePosition(node, starts).line, column: nodePosition(node, starts).column, path: null });
    } else {
      issue(errors, 'invalid_style', 'unknown T style: ' + param, nodePosition(node, starts), null, 'allowed: B,U,I,D,up,down,!rrggbb,!!rrggbb,link/"url"');
    }
  }
  if (seen.has('up') && seen.has('down')) issue(errors, 'invalid_style', 'up and down cannot be used together', nodePosition(node, starts), null);
  if (node.content.trim() === '') issue(warnings, 'empty_text', 'T content is empty', nodePosition(node, starts), null);
}

function validateCloze(node, starts, errors, warnings, inFormula) {
  if (!/^[1-9]\d*$/.test(node.params)) issue(errors, 'invalid_cloze_group', 'F needs a positive integer group starting at 1', nodePosition(node, starts), null);
  if (node.content.trim() === '') issue(errors, 'invalid_cloze', 'F content is empty', nodePosition(node, starts), null);
  if (!inFormula && hasUnescapedBrackets(node.content)) {
    issue(errors, 'cloze_nested', 'a normal F cannot contain other tags; put styles outside the cloze', nodePosition(node, starts), null);
  }
  if (inFormula && node.content.includes('[F#')) issue(errors, 'cloze_nested', 'do not nest F tags', nodePosition(node, starts), null);
}

function validateParagraph(node, starts, errors, warnings) {
  const params = splitParams(node.params);
  const seen = new Set();
  for (const param of params) {
    if (['H1', 'center', 'left', 'right', 'L'].includes(param)) {
      if (seen.has(param)) issue(errors, 'duplicate_paragraph_style', 'duplicate paragraph style: ' + param, nodePosition(node, starts), null);
      seen.add(param);
    } else if (/^I[1-9]\d*$/.test(param)) {
      if ([...seen].some((value) => /^I\d+$/.test(value))) issue(errors, 'duplicate_paragraph_style', 'more than one indent', nodePosition(node, starts), null);
      seen.add(param);
    } else {
      issue(errors, 'invalid_paragraph_style', 'unknown P style: ' + param, nodePosition(node, starts), null, 'allowed: H1,center,left,right,L,I<n>');
    }
  }
  if ((seen.has('left') ? 1 : 0) + (seen.has('right') ? 1 : 0) + (seen.has('center') ? 1 : 0) > 1) {
    issue(errors, 'conflicting_alignment', 'a paragraph can use only one alignment', nodePosition(node, starts), null);
  }
  for (const child of node.children) {
    if (child.name === 'P' || child.name === 'Choice' || child.name === 'Pic' || child.name === 'E') {
      issue(errors, 'block_in_paragraph', child.name + ' is block-level and cannot be nested in P', nodePosition(child, starts), null);
    } else if (!INLINE_TAGS.has(child.name)) {
      issue(errors, 'unknown_tag', 'unknown tag ' + child.name + ' inside P', nodePosition(child, starts), null);
    } else {
      validateNode(child, starts, errors, warnings, { inParagraph: true });
    }
  }
  if (node.content.trim() === '') issue(warnings, 'empty_paragraph', 'P content is empty', nodePosition(node, starts), null);
}

function validateChoice(node, starts, errors, warnings) {
  const params = node.params;
  if (!['', 'fixed', 'multi', 'fixed,multi'].includes(params)) {
    issue(errors, 'invalid_choice_params', 'Choice params must be empty, fixed, multi, or fixed,multi', nodePosition(node, starts), null);
  }
  const body = node.content.replace(/^\n/, '').replace(/\n$/, '');
  const lines = body.split('\n');
  const options = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === '') continue;
    if (/^[ \t]/.test(line)) {
      issue(errors, 'choice_indent', 'Choice options must start at the beginning of a line', nodePosition(node, starts), null);
      continue;
    }
    if (!/^[*-] /.test(line)) {
      issue(errors, 'choice_option', 'choice options must start with "* " or "- "', nodePosition(node, starts), null);
      continue;
    }
    options.push(line);
  }
  if (options.length === 0) issue(errors, 'choice_empty', 'Choice needs at least one option', nodePosition(node, starts), null);
  const correct = options.filter((line) => line.startsWith('* ')).length;
  if (correct === 0) issue(errors, 'choice_no_correct', 'Choice needs one * correct option', nodePosition(node, starts), null);
  if (correct > 1 && !params.includes('multi')) issue(errors, 'choice_multi', 'more than one * option requires [Choice#multi# or [Choice#fixed,multi#', nodePosition(node, starts), null);
  if (correct === 1 && params.includes('multi')) issue(errors, 'choice_multi', 'a single * option must use [Choice## (not multi)', nodePosition(node, starts), null);
  for (const child of node.children) {
    if (!['T', 'E'].includes(child.name)) issue(errors, 'choice_nested', 'choice options may only contain T and E tags, found ' + child.name, nodePosition(child, starts), null);
    else validateNode(child, starts, errors, warnings, { inChoice: true });
  }
}

function validatePicture(node, starts, errors) {
  const params = splitParams(node.params);
  if (node.content.trim() !== '') issue(errors, 'pic_content', 'Pic content must be empty; end with #]', nodePosition(node, starts), null);
  if (params.length === 0 || params.length > 2) issue(errors, 'invalid_pic', 'Pic needs ID/<file.id> and optional MID/<mask.id>', nodePosition(node, starts), null);
  const seen = new Set();
  for (const param of params) {
    const match = /^(ID|MID)\/(.+)$/.exec(param);
    if (!match) {
      issue(errors, 'invalid_pic', 'Pic parameter must be ID/<file.id> or MID/<mask.id>', nodePosition(node, starts), null);
      continue;
    }
    if (seen.has(match[1])) issue(errors, 'duplicate_pic', 'duplicate ' + match[1] + ' parameter', nodePosition(node, starts), null);
    seen.add(match[1]);
    try {
      checkFileId(match[2], 'pic');
    } catch (error) {
      issue(errors, 'invalid_file_id', error.message, nodePosition(node, starts), null);
    }
  }
  if (seen.has('MID') && !seen.has('ID')) issue(errors, 'invalid_pic', 'MID must follow ID (ID is the original image)', nodePosition(node, starts), null);
}

function validateAudio(node, starts, errors, warnings) {
  const params = splitParams(node.params);
  if (hasUnescapedBrackets(node.content)) issue(errors, 'audio_nested', 'Audio label cannot contain tags', nodePosition(node, starts), null);
  let hasId = false;
  let hasManual = false;
  let hasAuto = false;
  for (const param of params) {
    if (/^ID\/.+$/.test(param)) {
      hasId = true;
      try { checkFileId(param.slice(3), 'audio'); }
      catch (error) { issue(errors, 'invalid_file_id', error.message, nodePosition(node, starts), null); }
    }
    else if (param === 'M') hasManual = true;
    else if (param === 'A') hasAuto = true;
    else if (param === 'D') {
      /* follow the user's setting */
    } else issue(errors, 'invalid_audio', 'unknown Audio parameter: ' + param, nodePosition(node, starts), null);
  }
  if (!hasId) issue(errors, 'invalid_audio', 'Audio needs ID/<file.id>', nodePosition(node, starts), null);
  if (hasManual && hasAuto) issue(errors, 'invalid_audio', 'Audio cannot use M and A together', nodePosition(node, starts), null);
  if (node.content.trim() === '') warnings.push({ code: 'empty_audio_label', message: 'Audio label is empty (valid, but an empty label is less helpful)', line: nodePosition(node, starts).line, column: nodePosition(node, starts).column, path: null });
}

function validateCardRef(node, starts, errors) {
  const match = /^ID\/(.+)$/.exec(node.params);
  if (!match) {
    issue(errors, 'invalid_card_ref', 'Card needs ID/<root_id>', nodePosition(node, starts), null);
    return;
  }
  const ids = match[1].split('-');
  if (ids.length > MAX_CARD_REFS) issue(errors, 'invalid_card_ref', 'Card can reference at most ' + MAX_CARD_REFS + ' cards', nodePosition(node, starts), null);
  for (const id of ids) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_]*$/.test(id)) issue(errors, 'invalid_card_ref', 'Card root_id must be a real root_id, not a card/deck/file id: ' + id, nodePosition(node, starts), null);
  }
  if (hasUnescapedBrackets(node.content)) issue(errors, 'card_ref_nested', 'Card label cannot contain tags', nodePosition(node, starts), null);
}

function validateFormula(node, starts, errors, warnings) {
  if (node.params !== '') issue(errors, 'invalid_formula', 'E uses [E##...] with no parameters', nodePosition(node, starts), null);
  if (node.content.trim() === '') issue(errors, 'invalid_formula', 'E formula content is empty', nodePosition(node, starts), null);
  if (node.content.includes('$')) issue(errors, 'formula_delimiter', 'do not wrap formula content in $, $$, \\( or \\[', nodePosition(node, starts), null);
  if (/\\[()[\]]/.test(node.content)) issue(errors, 'formula_delimiter', 'do not add \\( \\) \\[ \\] formula delimiters', nodePosition(node, starts), null);
  const clozeMatches = [...node.content.matchAll(/\[F#([^\]]*)\]|\[F#([^\]]*)$/g)];
  for (const match of clozeMatches) {
    const group = (match[0].match(/^\[F#([^\]]*)#/) || [])[1];
    if (group === undefined || !/^[1-9]\d*$/.test(group)) issue(errors, 'invalid_cloze_group', 'formula cloze needs a positive integer group', nodePosition(node, starts), null);
  }
  if (/\[(?!F#)[A-Za-z]/.test(node.content)) issue(errors, 'formula_nested', 'only F is allowed inside E; remove other tags', nodePosition(node, starts), null);
  if (/\[F#/.test(node.content) && !/\[F#[1-9]\d*#[^\]]+\]/.test(node.content)) issue(errors, 'formula_cloze', 'formula cloze must close as [F#1#...]', nodePosition(node, starts), null);
}

function validateNode(node, starts, errors, warnings, context) {
  const contextValue = context || {};
  if (node.name === 'T') return validateText(node, starts, errors, warnings);
  if (node.name === 'F') return validateCloze(node, starts, errors, warnings, contextValue.inFormula === true);
  if (node.name === 'P') return validateParagraph(node, starts, errors, warnings);
  if (node.name === 'Choice') return validateChoice(node, starts, errors, warnings);
  if (node.name === 'Pic') return validatePicture(node, starts, errors);
  if (node.name === 'Audio') return validateAudio(node, starts, errors, warnings);
  if (node.name === 'Card') return validateCardRef(node, starts, errors);
  if (node.name === 'E') return validateFormula(node, starts, errors, warnings);
  issue(errors, 'unknown_tag', 'unknown tag ' + node.name + '; allowed tags: T,P,F,Choice,Pic,Audio,Card,E', nodePosition(node, starts), null);
}

function checkBlockStart(node, content, starts, errors) {
  if (!BLOCK_TAGS.has(node.name) && node.name !== 'E') return;
  const lineStart = content.lastIndexOf('\n', node.start - 1) + 1;
  const prefix = content.slice(lineStart, node.start);
  if (prefix.trim() === '' && prefix !== '') {
    issue(errors, 'block_indent', node.name + ' must start at the first character of a line (no leading spaces)', nodePosition(node, starts), null);
  } else if (prefix !== '') {
    if (node.name === 'E') return; // inline formula is valid
    issue(errors, 'block_position', node.name + ' is block-level and must start on a new line', nodePosition(node, starts), null);
  }
}

export function validateCardContent(content) {
  const errors = [];
  const warnings = [];
  if (typeof content !== 'string') {
    return { ok: false, errors: [{ code: 'invalid_content', message: 'content must be a string', line: null, column: null, path: null }], warnings, stats: null };
  }
  if (content.length > CONTENT_MAX) {
    return { ok: false, errors: [{ code: 'content_too_long', message: 'content is ' + content.length + ' characters, max ' + CONTENT_MAX, line: null, column: null, path: null }], warnings, stats: null };
  }
  if (content.trim() === '') {
    return { ok: false, errors: [{ code: 'empty_content', message: 'content must not be empty', line: 1, column: 1, path: null }], warnings, stats: null };
  }
  const scanned = scanContent(content);
  errors.push(...scanned.errors);
  warnings.push(...scanned.warnings);
  for (const node of scanned.nodes) {
    checkBlockStart(node, content, scanned.starts, errors);
    validateNode(node, scanned.starts, errors, warnings, {});
  }
  const lines = content.split('\n');
  let answerLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === '---') answerLines += 1;
    else if (/^\s*---\s*$/.test(line)) issue(errors, 'answer_line', '--- must be on its own line with no spaces or text', { line: index + 1, column: 1 }, null);
  }
  // Placeholders and obvious media mistakes are common in AI-generated cards.
  for (const match of content.matchAll(/<(?:[^<>\n]{1,40})>/g)) {
    const value = match[0];
    if (/<(?:image|audio|mask|file|root|title|body|option|answer|序号|标题|正文|选项|解析|题目|中文标题|外文标题|imageFileId|audioFileId|maskFileId|fileId|root_id)/i.test(value)) {
      issue(warnings, 'placeholder', 'unfilled template placeholder: ' + value, positionOf(scanned.starts, match.index), null, 'replace it with a real value before writing');
    }
  }
  const stats = {
    chars: content.length,
    lines: lines.length,
    answer_lines: answerLines,
    paragraphs: 0,
    choices: 0,
    images: 0,
    audio: 0,
    card_refs: 0,
    formulas: 0,
    clozes: 0,
    text_styles: 0,
  };
  function count(node) {
    if (node.name === 'P') stats.paragraphs += 1;
    if (node.name === 'Choice') stats.choices += 1;
    if (node.name === 'Pic') stats.images += 1;
    if (node.name === 'Audio') stats.audio += 1;
    if (node.name === 'Card') stats.card_refs += 1;
    if (node.name === 'E') stats.formulas += 1;
    if (node.name === 'F') stats.clozes += 1;
    if (node.name === 'T') stats.text_styles += 1;
    for (const child of node.children || []) count(child);
  }
  for (const node of scanned.nodes) count(node);
  return { ok: errors.length === 0, errors, warnings, stats };
}

export function syntaxGuide() {
  return {
    version: 1,
    source: 'https://tutuji333.github.io/markji-faq/questions/content/card-syntax-guide/',
    preferred_modes: [
      'front/back: plain-text Q&A, no Markji syntax required (best for simple cards).',
      'spec: explicit pages/blocks for all supported syntax; compiled and validated before writing.',
      'content: raw Markji rich text for anything not covered by spec; validated but not rejected.',
    ],
    spec: {
      pages: 'array of pages; each page is an array of blocks. Pages become --- answer lines: page 1 question, page 2 answer/reveal, page 3 another reveal.',
      blocks: {
        heading: '{type:"heading", text:"...", subtitle?:"..."} -> [P#H1,center#[T#B#...]] and optional centered subtitle. No other heading level.',
        paragraph: '{type:"paragraph", text:"..." or runs:[...], align?:"center|left|right", indent?:1-9} -> text or [P#...]',
        list: '{type:"list", items:[string | {text|runs, level?:1-9}]} -> [P#L#...] / [P#L,I<n>#...]',
        choice: '{type:"choice", options:[...], correct?:1-based index or array, multiple?:boolean, fixed?:boolean} -> [Choice##...]; correct can also be option.correct=true.',
        image: '{type:"image", file:"<real file.id>", mask?:"<real mask file.id>"} -> [Pic#ID/...#]',
        audio: '{type:"audio", file:"<real file.id>", label?:"...", play?:"auto|manual|default"} -> [Audio#A,ID/...#...]',
        formula: '{type:"formula", latex:"..." or parts:[latex|{cloze,group?}]} -> [E##...] (parts supports formula cloze)',
        card_ref: '{type:"card_ref", ids:["root_id",...], label?:"..."} -> [Card#ID/...-...#...] (max 5)',
        link: '{type:"link", url:"https://...", label:"..."} -> [T#link/"..."#...]',
        raw: '{type:"raw", content:"..."} -> exact Markji syntax; use only for advanced cases',
      },
      runs: [
        'string -> plain text (brackets are escaped automatically)',
        '{text:"...", bold?, underline?, italic?, strike?, sup?, sub?, color?:"rrggbb", background?:"rrggbb", link?:"https://..."} -> [T#styles#...]',
        '{formula:"..."} or {formula_parts:[...]} -> inline [E##...]',
        '{cloze:"...", group?:positive integer} -> [F#group#...]; omitted group gets the next group automatically',
        '{url:"https://...", label:"..."} -> inline link',
        '{cards:["root_id"], label:"..."} -> inline [Card#ID/...#...]',
      ],
    },
    examples: {
      simple_qa: { front: '光合作用主要发生在哪里？', back: '叶绿体。' },
      structured: {
        pages: [
          [
            { type: 'heading', text: '幸存者偏差', subtitle: 'Survivorship Bias' },
            { type: 'paragraph', text: '我们为什么只看到了成功者？' },
          ],
          [
            { type: 'paragraph', runs: [
              { text: '因为我们只看到了', },
              { text: '活下来的赢家', bold: true, color: 'ff2600' },
              { text: '，却忽略了死掉的沉默大多数。' },
            ] },
          ],
        ],
      },
      choice: {
        pages: [
          [
            { type: 'paragraph', text: '下列哪一项是正确的？' },
            { type: 'choice', options: ['正确选项', '错误选项一', '错误选项二'], correct: 1, fixed: true },
          ],
          [{ type: 'paragraph', text: '答案解析。' }],
        ],
      },
      cloze_formula: {
        pages: [
          [
            { type: 'paragraph', runs: [
              { text: '斜率公式是 ' },
              { formula_parts: ['k=', { cloze: '\\frac{\\Delta y}{\\Delta x}', group: 1 }] },
              { text: '。' },
            ] },
          ],
        ],
      },
      image_audio: {
        pages: [
          [
            { type: 'heading', text: '听音辨图' },
            { type: 'audio', file: 'mkjf_audio_id', label: '点击播放' },
            { type: 'image', file: 'mkjf_image_id' },
          ],
          [{ type: 'paragraph', text: '答案正文。' }],
        ],
      },
    },
    raw_cheatsheet: {
      answer_line: '--- on its own line; separates question from answer/reveal. Use more than one for multiple reveals.',
      paragraph: '[P#style#content]; H1,center title = [P#H1,center#[T#B#title]]; plain paragraphs need no P tag.',
      text: '[T#styles#text]; styles: B,U,I,D,up,down,!rrggbb,!!rrggbb,link/"url"; combine with commas.',
      cloze: '[F#positive_group#hidden]; same group reveals together; use [E##text[F#1#latex]text] for formula cloze.',
      formula: '[E##KaTeX]; block formulas start at the beginning of a line; no $ delimiters.',
      choice: '[Choice##\\n* correct\\n- wrong\\n] / [Choice#multi# / [Choice#fixed# / [Choice#fixed,multi#; closing ] on its own line.',
      image: '[Pic#ID/real_file_id#] or [Pic#ID/real_image_id,MID/real_mask_id#]; empty content.',
      audio: '[Audio#A,ID/real_file_id#label]; M=manual, A=auto, D=follow setting; M and A are exclusive.',
      card_ref: '[Card#ID/root_id#label]; multiple root ids joined by -; max 5.',
      link: '[T#link/"https://..."#label]; encode # as %23 and commas as %2C.',
      escape: 'literal [ and ] become \\[ and \\] in ordinary text; do not escape the tag delimiters.',
      media: 'Upload first with markji_file, then use the real file.id; never use a path, URL, filename, or preview mask.',
    },
    hard_rules: [
      'Keep real newlines; never write \\n as two characters.',
      'Each tag must close with an unescaped ]; P, Choice, Pic, block E, and --- start at column 1.',
      'Choice: one * -> [Choice##; more than one * -> [Choice#multi#; fixed order adds fixed; closing ] on its own line.',
      'T content cannot contain other tags; F content cannot contain other tags except F inside E for formula cloze.',
      'Use [E##...] only for KaTeX; do not wrap in $, $$, \\(...\\), or \\[...\\].',
      'Media needs a real Markji file.id and grammar_version: 3; never use <imageFileId>, local paths, or URLs.',
      'Card references need root_id, not card.id, deck_id, file.id, title, or a guessed string.',
    ],
    warnings: [
      'Placeholders such as <imageFileId>, <标题>, and <root_id> are rejected by the guide and flagged by validate.',
      'Do not manually paste HTML; convert <b>/<u>/<span style> to Markji T styles.',
      'Do not create masks without matching the final image dimensions; use the .msk1 JSON format from the guide.',
    ],
  };
}
