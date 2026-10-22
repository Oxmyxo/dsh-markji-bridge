// dsh-markji-bridge: derive a searchable plain-text view of Markji rich-text content.
//
// Card content is the Markji rich-text grammar documented in DESIGN.md
// ([T#B#...], [F#1#...], [Pic#ID/...#], [Audio#...#], [Card#...#], [P#...#],
// [Choice#...#], [E##...], "---" separators). Some cards also embed media as
// data URIs or raw base64, which must never leak into search results or
// snippets. Everything that is pure decoration or a media reference is
// dropped; only human-readable text (including code and LaTeX) is kept.

const BASE64_RUN_MIN = 120;

const HTML_TAGS = [
  'p', 'br', 'div', 'span', 'img', 'audio', 'video', 'source', 'picture',
  'b', 'strong', 'i', 'em', 'u', 's', 'del', 'sub', 'sup', 'mark',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'table', 'thead', 'tbody', 'tr', 'td', 'th', 'blockquote',
  'code', 'pre', 'figure', 'figcaption',
];
const HTML_TAG_RE = new RegExp('</?(?:' + HTML_TAGS.join('|') + ')\\b[^>]*>', 'gi');
const HTML_BR_RE = /<br\s*\/?>/gi;
const DATA_URI_RE = /data:[a-z0-9.+-]+\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*;base64,[a-z0-9+/=\r\n]+/gi;
const BASE64_RUN_RE = new RegExp('[A-Za-z0-9+/]{' + BASE64_RUN_MIN + ',}={0,2}', 'g');

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&#x27;': "'",
};

function stripHtml(text) {
  let out = text.replace(HTML_BR_RE, '\n');
  out = out.replace(HTML_TAG_RE, '');
  out = out.replace(/&(nbsp|amp|lt|gt|quot|#39|#x27);/gi, (match) => ENTITIES[match.toLowerCase()] ?? match);
  return out;
}

function stripMarkdownMedia(text) {
  // Markdown image/link: keep the caption or link label, drop the target
  // (data URIs and long URLs are noise for search and snippets).
  let out = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  out = out.replace(/\[([^\]]*)\]\(([^)]*)\)/g, '$1');
  return out;
}

function stripChoiceBlocks(text) {
  // [Choice#fixed,multi# ... ] -> option text only, one per line.
  return text.replace(/\[Choice#[^\n]*\n([\s\S]*?)\n\]/g, (match, body) => {
    return String(body)
      .split('\n')
      .map((line) => line.replace(/^[ \t]*[*-][ \t]?/, ''))
      .join('\n');
  });
}

/**
 * Convert one card's Markji rich-text content into searchable plain text.
 * Media references, formatting tags and Choice/block markup are removed;
 * visible text (questions, answers, code, formulas, option text) is kept.
 *
 * Results are memoized by content string: search and persistence both call this
 * for every cached card, and card content is immutable within a save cycle.
 */
const PLAIN_TEXT_CACHE = new Map();
const PLAIN_TEXT_CACHE_MAX = 20000;

export function plainText(content) {
  if (typeof content !== 'string' || content === '') return '';
  const cached = PLAIN_TEXT_CACHE.get(content);
  if (cached !== undefined) return cached;
  const value = computePlainText(content);
  if (PLAIN_TEXT_CACHE.size >= PLAIN_TEXT_CACHE_MAX) PLAIN_TEXT_CACHE.clear();
  PLAIN_TEXT_CACHE.set(content, value);
  return value;
}

function computePlainText(content) {
  let text = content.replace(/\r\n?/g, '\n');

  text = stripHtml(text);
  text = text.replace(DATA_URI_RE, '');
  text = text.replace(BASE64_RUN_RE, '');

  // Strip Markji markup before Markdown handling: a styled run such as
  // "str.[T#B#find](sub)" is code, not a Markdown link, and letting the
  // Markdown pass run first would keep the "T#B#" style prefix in the text.
  // Inline styles: keep the styled text.
  text = text.replace(/\[T#[^\]]*#([\s\S]*?)\]/g, '$1');
  // Cloze: keep the hidden text so it is searchable.
  text = text.replace(/\[F#[^\]]*#([\s\S]*?)\]/g, '$1');
  // Audio: keep the optional caption; the media itself is dropped.
  text = text.replace(/\[Audio#[^\]]*#([^\]]*)\]/g, '$1');
  // Linked cards: keep the caption.
  text = text.replace(/\[Card#[^\]]*#([^\]]*)\]/g, '$1');
  // Pictures / masks: drop entirely.
  text = text.replace(/\[Pic#[^\]]*\]/g, '');

  text = stripChoiceBlocks(text);

  // Paragraph style: keep the paragraph text.
  text = text.replace(/\[P#[^\]]*#([\s\S]*?)\]/g, '$1');
  // Standalone formula: keep the LaTeX source.
  text = text.replace(/\[E##([\s\S]*?)\]/g, '$1');

  // Markdown image/link on the remaining text: keep the label, drop the target.
  text = stripMarkdownMedia(text);

  // Answer separator line.
  text = text.replace(/^[ \t]*---[ \t]*$/gm, '');

  // Restore escaped brackets after tag stripping.
  text = text.replace(/\\([\[\]\\])/g, '$1');

  text = text.replace(/[ \t]+\n/g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');
  return text.trim();
}

/** Whether a content string has a plain-text form worth searching. */
export function hasPlainText(content) {
  return plainText(content).length > 0;
}

export const PLAIN_TEXT_VERSION = 2;
