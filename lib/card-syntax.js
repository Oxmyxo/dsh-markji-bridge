// dsh-markji-bridge: validate raw Markji rich-text before a card is queued or pushed.
//
// This module intentionally only validates hand-written Markji syntax. It does not
// compile a custom spec or generate content from plain text. Media ids are collected
// from valid Pic/Audio tags so markji_sync can check them against the provider.
//
// Syntax source: https://tutuji333.github.io/markji-faq/questions/content/card-syntax-guide/

const CONTENT_MAX = 100000;
const MAX_CARD_REFS = 5;
const STYLE_FLAGS = new Set(['B', 'U', 'I', 'D', 'up', 'down']);
const INLINE_TAGS = new Set(['T', 'F', 'Audio', 'Card']);
const BLOCK_TAGS = new Set(['P', 'Choice', 'Pic']);

function fail(path, message, hint) {
  const error = new Error(message);
  error.name = 'CardSyntaxError';
  error.code = 'invalid_card_syntax';
  error.path = path;
  if (typeof hint === 'string' && hint !== '') error.hint = hint;
  throw error;
}

function checkFileId(value, path) {
  const id = String(value === undefined || value === null ? '' : value).trim();
  if (id.length < 1 || id.length > 256) fail(path, 'must be a real Markji file.id (letters, digits, _, . or -), not a filename or URL');
  if (!/^[A-Za-z0-9]/.test(id)) fail(path, 'must be a real Markji file.id (letters, digits, _, . or -), not a filename or URL');
  for (const ch of id) {
    if (!/[A-Za-z0-9_.-]/.test(ch)) fail(path, 'must be a real Markji file.id (letters, digits, _, . or -), not a filename or URL');
  }
  return id;
}

function hasUnescapedBrackets(text) {
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\\') {
      index += 1;
      continue;
    }
    if (text[index] === '[' || text[index] === ']') return true;
  }
  return false;
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

  function findMarkdownLink(open) {
    let cursor = open + 1;
    while (cursor < content.length) {
      if (content[cursor] === '\\' && (content[cursor + 1] === '[' || content[cursor + 1] === ']')) {
        cursor += 2;
        continue;
      }
      if (content[cursor] === '\n') return -1;
      if (content[cursor] === ']') break;
      cursor += 1;
    }
    if (cursor >= content.length || content[cursor] !== ']') return -1;
    cursor += 1;
    if (content[cursor] !== '(') return -1;
    cursor += 1;
    let depth = 1;
    while (cursor < content.length) {
      if (content[cursor] === '\\') {
        cursor += 2;
        continue;
      }
      if (content[cursor] === '\n') return -1;
      if (content[cursor] === '(') depth += 1;
      else if (content[cursor] === ')') {
        depth -= 1;
        if (depth === 0) return cursor;
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
      // Markdown inline links / images are literal content in Markji cards, not tags.
      const markdownEnd = findMarkdownLink(cursor);
      if (markdownEnd >= 0) {
        cursor = markdownEnd + 1;
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
    return { ok: false, errors: [{ code: 'invalid_content', message: 'content must be a string', line: null, column: null, path: null }], warnings, stats: null, media: [] };
  }
  if (content.length > CONTENT_MAX) {
    return { ok: false, errors: [{ code: 'content_too_long', message: 'content is ' + content.length + ' characters, max ' + CONTENT_MAX, line: null, column: null, path: null }], warnings, stats: null, media: [] };
  }
  if (content.trim() === '') {
    return { ok: false, errors: [{ code: 'empty_content', message: 'content must not be empty', line: 1, column: 1, path: null }], warnings, stats: null, media: [] };
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
  const media = [];
  function collectMedia(node) {
    if (node.name === 'Pic' || node.name === 'Audio') {
      for (const param of splitParams(node.params)) {
        const match = /^(ID|MID)\/(.+)$/.exec(param);
        if (!match) continue;
        const id = match[2];
        if (id === '' || id.includes('/')) continue;
        let valid = /^[A-Za-z0-9]/.test(id);
        for (const ch of id) if (!/[A-Za-z0-9_.-]/.test(ch)) valid = false;
        if (!valid) continue;
        const at = nodePosition(node, scanned.starts);
        media.push({ kind: node.name === 'Audio' ? 'audio' : match[1] === 'MID' ? 'mask' : 'image', id, line: at.line, column: at.column });
      }
    }
    for (const child of node.children || []) collectMedia(child);
  }
  for (const node of scanned.nodes) collectMedia(node);

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
  return { ok: errors.length === 0, errors, warnings, stats, media };
}
