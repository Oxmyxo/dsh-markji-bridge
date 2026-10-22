/**
 * dsh-markji-bridge - model-facing tools.
 *
 * Registers the 17 markji_* tools. Reads are served from the local cache, every
 * write is queued locally, and markji_sync (or the engine idle auto-sync) pulls
 * remote changes and pushes the queue. markji_sync returns a background task
 * handle immediately and markji_sync_status reports its progress, including
 * resuming a task interrupted by a host crash. Only markji_file talks to the
 * network directly inside a tool call, because uploaded files are not cached.
 *
 * Contract: DESIGN.md, section "lib/tools.js + index.js".
 */

import { validateCardContent } from './card-syntax.js';
import { getSyntaxHelp } from './card-syntax-help.js';

/** Tool names in registration order. */
export const TOOL_NAMES = [
  'markji_decks',
  'markji_chapters',
  'markji_cards',
  'markji_search',
  'markji_card_get',
  'markji_card_syntax',
  'markji_card_create',
  'markji_card_update',
  'markji_card_archive',
  'markji_cards_move',
  'markji_chapters_edit',
  'markji_sync',
  'markji_sync_status',
  'markji_failures',
  'markji_status',
  'markji_conflict_resolve',
  'markji_file',
];

const SYNC_MODES = ['auto', 'pull', 'push'];
const CHAPTER_ACTIONS = ['create', 'rename', 'sort'];
const CONFLICT_STRATEGIES = ['keep_local', 'keep_remote', 'use_content'];
const FILE_ACTIONS = ['upload', 'query'];

/**
 * Shared semantics appended to every tool description. The descriptions are the
 * agent's only documentation, so the cache / queued edit / sync / conflict /
 * id / content rules are repeated where every tool can see them.
 */
const CACHE_NOTE =
  'Markji data is served from a local cache and writes are queued locally: markji_sync, or the plugin idle auto-sync after a quiet period, pushes the queue and pulls remote changes, so a read may be slightly stale. ' +
  'If a card changed both locally and remotely, the edit is recorded as a conflict (returned in the completed markji_sync task report and visible in markji_status) and the remaining cards are still pushed; resolve it with markji_conflict_resolve. ' +
  'deck/chapter/card ids are Markji OpenAPI ids (local_* ids exist only for unsynced new items), and card content is Markji rich-text, where plain text is valid.';

const STRING = (description) => ({ type: 'string', description });
const INTEGER = (description) => ({ type: 'integer', description });
const BOOLEAN = (description) => ({ type: 'boolean', description });
const STRING_ARRAY = (description) => ({ type: 'array', items: { type: 'string' }, description });
const ENUM = (values, description) => ({ type: 'string', enum: values, description });

/** Serialize one tool value as pretty JSON, capped by the configured limit. */
function prettyJson(value, maxChars) {
  let text;
  try {
    text = JSON.stringify(value, null, 2);
  } catch (error) {
    text = String(value);
  }
  if (typeof text !== 'string') text = String(text);
  const limit = Number.isFinite(maxChars) && maxChars > 0 ? Math.trunc(maxChars) : 20000;
  if (text.length <= limit) return text;
  return text.slice(0, limit) + '\n... (truncated after ' + limit + ' of ' + text.length + ' characters)';
}

/** The one object output definition shared by every tool. */
function outputDefinition(config) {
  const maxChars = Number.isFinite(config.maxOutputChars) ? Math.trunc(config.maxOutputChars) : 20000;
  return {
    schema: { type: 'object' },
    render: (_args, value) => [{ type: 'text', text: prettyJson(value, maxChars) }],
  };
}

/** Tool arguments must be a plain object; anything else is treated as empty. */
function asArguments(args) {
  return args !== null && typeof args === 'object' && !Array.isArray(args) ? args : {};
}

function readRawString(args, key, tool) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(tool + ': "' + key + '" must be a string');
  return value;
}

function requireRawString(args, key, tool, hint) {
  const text = readRawString(args, key, tool);
  if (text === undefined || text.trim() === '') {
    throw new Error(tool + ': "' + key + '" is required' + (typeof hint === 'string' && hint !== '' ? ' (' + hint + ')' : ''));
  }
  return text;
}

function readString(args, key, tool) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new Error(tool + ': "' + key + '" must be a string');
  const text = value.trim();
  return text === '' ? undefined : text;
}

function requireString(args, key, tool, hint) {
  const text = readString(args, key, tool);
  if (text === undefined) {
    throw new Error(tool + ': "' + key + '" is required' + (typeof hint === 'string' && hint !== '' ? ' (' + hint + ')' : ''));
  }
  return text;
}

function readInteger(args, key, tool, min, max) {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) throw new Error(tool + ': "' + key + '" must be a number');
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function readBoolean(args, key, tool) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'boolean') return value;
  const text = String(value).trim().toLowerCase();
  if (text === 'true' || text === '1' || text === 'yes' || text === 'on') return true;
  if (text === 'false' || text === '0' || text === 'no' || text === 'off') return false;
  throw new Error(tool + ': "' + key + '" must be a boolean');
}

function readEnum(args, key, tool, values) {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || values.indexOf(value.trim()) < 0) {
    throw new Error(tool + ': "' + key + '" must be one of: ' + values.join(', '));
  }
  return value.trim();
}

function requireEnum(args, key, tool, values, hint) {
  const value = readEnum(args, key, tool, values);
  if (value === undefined) {
    throw new Error(tool + ': "' + key + '" is required' + (typeof hint === 'string' && hint !== '' ? ' (' + hint + ')' : ''));
  }
  return value;
}

function readStringArray(args, key, tool) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(tool + ': "' + key + '" must be an array of strings');
  const out = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new Error(tool + ': "' + key + '" must contain only strings');
    const text = item.trim();
    if (text !== '') out.push(text);
  }
  return out;
}

function requireStringArray(args, key, tool, hint) {
  const values = readStringArray(args, key, tool);
  if (values === undefined || values.length === 0) {
    throw new Error(
      tool + ': "' + key + '" must contain at least one id' + (typeof hint === 'string' && hint !== '' ? ' (' + hint + ')' : ''),
    );
  }
  return values;
}

/**
 * Turn any thrown value into the documented error shape. Provider failures carry
 * a MarkjiError code, so the message becomes "markji: <code>: <message>" and the
 * harness reports an isError result instead of discarding the code.
 */
function toToolError(error) {
  const source = error !== null && typeof error === 'object' ? error : null;
  const code = source !== null && typeof source.code === 'string' && source.code.trim() !== '' ? source.code.trim() : '';
  const message =
    source !== null && typeof source.message === 'string' && source.message !== ''
      ? source.message
      : String(error === undefined ? 'unknown error' : error);
  const hint = source !== null && typeof source.hint === 'string' && source.hint.trim() !== '' ? source.hint.trim() : '';
  const suffix = hint === '' ? '' : ' (hint: ' + hint + ')';
  if (code !== '') return new Error('markji: ' + code + ': ' + message + suffix);
  return new Error(message === '' ? 'markji: unknown error' : message);
}

/** Resolve one engine method, failing with a clear message if the engine is missing. */
function engineMethod(engine, name) {
  if (engine === null || engine === undefined || typeof engine[name] !== 'function') {
    throw new Error('markji: engine_unavailable: the sync engine does not provide ' + name + '(); restart the plugin');
  }
  return engine[name].bind(engine);
}

/** Resolve the Markji HTTP client used by markji_file. */
function requireClient(client) {
  if (client === null || client === undefined || typeof client.uploadFile !== 'function' || typeof client.queryFiles !== 'function') {
    throw new Error('markji: not_configured: the Markji API client is not available in this plugin context');
  }
  return client;
}

/** Register one tool definition. */
function registerTool(ctx, engine, config, spec) {
  return ctx.tools.register({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: outputDefinition(config),
    ...(spec.timeoutMs === undefined ? {} : { timeoutMs: spec.timeoutMs }),
    async execute(rawArgs) {
      const args = asArguments(rawArgs);
      try {
        // The plugin starts the engine without blocking apply(); the first tool
        // call waits for the cache load and auto-sync timer instead.
        if (engine !== null && engine !== undefined && typeof engine.ready === 'function') await engine.ready();
        const value = await spec.run(args);
        if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value;
        return { ok: true, result: value === undefined ? null : value };
      } catch (error) {
        throw toToolError(error);
      }
    },
  });
}

/**
 * Register the markji_* tools.
 *
 * @param ctx - plugin context exposing ctx.tools.register.
 * @param deps - { engine, config, log, client }; client is the shared HTTP
 *   client used by markji_file (it also carries the shared rate limiter).
 * @returns a disposer that unregisters every tool.
 */
export function registerTools(ctx, deps = {}) {
  if (
    ctx === null ||
    typeof ctx !== 'object' ||
    ctx.tools === null ||
    typeof ctx.tools !== 'object' ||
    typeof ctx.tools.register !== 'function'
  ) {
    throw new Error('registerTools(ctx, deps) requires ctx.tools.register');
  }
  const engine = deps.engine === undefined ? null : deps.engine;
  const config = deps.config !== null && typeof deps.config === 'object' ? deps.config : {};
  const log = typeof deps.log === 'function' ? deps.log : null;
  const client = deps.client === undefined ? null : deps.client;

  const disposers = [];
  const add = (spec) => {
    disposers.push(registerTool(ctx, engine, config, spec));
  };

  add({
    name: 'markji_decks',
    description:
      'List Markji decks and their folders from the local cache: folders is the deck tree (id, name, parent_id, items) and decks is the flat list (id, name, description, card_count, chapter_count, updated_time, is_private, source, missing). ' +
      'refresh=true forces a pull before reading; otherwise the cache is reused until its pull TTL expires, and a failed pull still returns cached data with cache.stale and cache.error set. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        refresh: BOOLEAN('Force a pull before reading instead of using the cache until its pull TTL expires.'),
        folder_id: STRING('Only list decks of this folder (a Markji OpenAPI folder id from the folders list).'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {};
      const folderId = readString(args, 'folder_id', 'markji_decks');
      if (folderId !== undefined) payload.folder_id = folderId;
      payload.refresh = readBoolean(args, 'refresh', 'markji_decks') === true;
      return engineMethod(engine, 'listDecks')(payload);
    },
  });

  add({
    name: 'markji_chapters',
    description:
      'List the chapters of one deck, or of every cached deck when deck is omitted, from the local cache. Each ChapterView has id, name, revision, order, card_count, pending, updated_time and local; when a deck is not cached yet, run markji_sync mode=pull full=true first. ' +
      'refresh=true forces a pull before reading; otherwise the cache is reused until its pull TTL expires. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        deck: STRING('Deck id (Markji OpenAPI id). Omit to list the chapters of every cached deck.'),
        refresh: BOOLEAN('Force a pull before reading instead of using the cache until its pull TTL expires.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {};
      const deck = readString(args, 'deck', 'markji_chapters');
      if (deck !== undefined) payload.deck = deck;
      payload.refresh = readBoolean(args, 'refresh', 'markji_chapters') === true;
      return engineMethod(engine, 'listChapters')(payload);
    },
  });

  add({
    name: 'markji_cards',
    description:
      'List and search cached cards, optionally filtered by deck and chapter, with case-insensitive substring matching over the card plain text (formatting tags, media references and embedded base64 are excluded; the card id is matched too). ' +
      'Returns total, offset, limit, has_more and CardSummary entries (id, deck_id, chapter_id, chapter_name, status synced|dirty|new|conflict, revision, snippet, updated_time). limit defaults to 50 and is capped at 200; page with offset. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        deck: STRING('Only cards of this deck (Markji OpenAPI deck id).'),
        chapter: STRING('Only cards of this chapter (Markji OpenAPI chapter id, or a local_* chapter id before its first push).'),
        query: STRING('Case-insensitive substring over the card plain text; also matches a card id.'),
        limit: INTEGER('Maximum cards to return, 1-200. Default 50.'),
        offset: INTEGER('Number of matching cards to skip, for paging. Default 0.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {};
      const deck = readString(args, 'deck', 'markji_cards');
      if (deck !== undefined) payload.deck = deck;
      const chapter = readString(args, 'chapter', 'markji_cards');
      if (chapter !== undefined) payload.chapter = chapter;
      const query = readString(args, 'query', 'markji_cards');
      if (query !== undefined) payload.query = query;
      const limit = readInteger(args, 'limit', 'markji_cards', 1, 200);
      if (limit !== undefined) payload.limit = limit;
      const offset = readInteger(args, 'offset', 'markji_cards', 0, 1000000);
      if (offset !== undefined) payload.offset = offset;
      return engineMethod(engine, 'listCards')(payload);
    },
  });

  add({
    name: 'markji_search',
    description:
      'Find and locate cached cards by deck name, chapter name, card plain text and last-updated time. All filters are optional and combine with AND; names and query are case-insensitive substrings over the plain-text view (formatting tags and media/base64 excluded), ids are exact. ' +
      'updated_after / updated_before accept ISO 8601 times (for example 2026-10-01 or 2026-10-01T08:00:00Z) or epoch milliseconds and filter on the card cloud updated_time, falling back to the local updated_time. ' +
      'Returns total, offset, limit, has_more, the normalized filters and CardSummary entries (id, deck_id, deck_name, chapter_id, chapter_name, status, revision, snippet centered on the content match, updated_time). ' +
      'refresh=true pulls changed decks before searching. Use it to find a card id before markji_card_get / markji_card_update; page with limit (default 20, max 100) and offset. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        query: STRING('Case-insensitive substring over the card plain text; also matches a card id.'),
        deck: STRING('Exact deck id to restrict the search.'),
        deck_name: STRING('Case-insensitive substring of the deck name.'),
        chapter: STRING('Exact chapter id to restrict the search.'),
        chapter_name: STRING('Case-insensitive substring of the chapter name.'),
        updated_after: STRING('Only cards updated at or after this time: ISO 8601 (2026-10-01T08:00:00Z) or epoch milliseconds.'),
        updated_before: STRING('Only cards updated at or before this time: ISO 8601 or epoch milliseconds.'),
        limit: INTEGER('Maximum cards to return, 1-100. Default 20.'),
        offset: INTEGER('Number of matching cards to skip, for paging. Default 0.'),
        refresh: BOOLEAN('Pull changed decks before searching. Default false.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {};
      const query = readString(args, 'query', 'markji_search');
      if (query !== undefined) payload.query = query;
      const deck = readString(args, 'deck', 'markji_search');
      if (deck !== undefined) payload.deck = deck;
      const deckName = readString(args, 'deck_name', 'markji_search');
      if (deckName !== undefined) payload.deck_name = deckName;
      const chapter = readString(args, 'chapter', 'markji_search');
      if (chapter !== undefined) payload.chapter = chapter;
      const chapterName = readString(args, 'chapter_name', 'markji_search');
      if (chapterName !== undefined) payload.chapter_name = chapterName;
      if (args.updated_after !== undefined && args.updated_after !== null && args.updated_after !== '') payload.updated_after = args.updated_after;
      if (args.updated_before !== undefined && args.updated_before !== null && args.updated_before !== '') payload.updated_before = args.updated_before;
      const limit = readInteger(args, 'limit', 'markji_search', 1, 100);
      if (limit !== undefined) payload.limit = limit;
      const offset = readInteger(args, 'offset', 'markji_search', 0, 1000000);
      if (offset !== undefined) payload.offset = offset;
      payload.refresh = readBoolean(args, 'refresh', 'markji_search') === true;
      return engineMethod(engine, 'searchCards')(payload);
    },
  });

  add({
    name: 'markji_card_get',
    description:
      'Read one cached card in full: content (rich text, needed for edits), text (plain-text view with formatting/media removed), grammar_version, chapter_name, status (synced|dirty|new|conflict), cloud revision/updated_time, the queued pending edit and the open conflict if any. ' +
      'On a cache miss the plugin pulls everything once, then fails with unknown_card. Pass deck when it is known to narrow the lookup. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        card: STRING('Card id (Markji OpenAPI id, or a local_* id before the first push).'),
        deck: STRING('Optional deck id, to narrow the cache lookup.'),
      },
      required: ['card'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const card = requireString(args, 'card', 'markji_card_get', 'the card id from markji_cards');
      const payload = { card };
      const deck = readString(args, 'deck', 'markji_card_get');
      if (deck !== undefined) payload.deck = deck;
      return engineMethod(engine, 'getCard')(payload);
    },
  });

  add({
    name: 'markji_card_syntax',
    description:
      'Validate raw Markji rich-text before creating or updating a card, or return static syntax help. ' +
      'action=validate (default) checks the exact content and returns ok, errors, warnings, stats and the media file ids it found; it never generates or rewrites content. ' +
      'action=help returns the raw Markji syntax reference; omit format for every format, or pass a format id, tag, or alias (text-style, cloze, audio, card-ref, paragraph, choice, picture, formula, answer-line) for one entry. ' +
      'markji_sync validates every queued card again and additionally checks those media ids against Markji before pushing. ' +
      'Run validate first, fix every error, then call markji_card_create or markji_card_update with the same content.',
    parameters: {
      type: 'object',
      properties: {
        action: ENUM(['validate', 'help'], 'validate checks content (default); help returns static syntax documentation and does not need content.'),
        content: STRING('Raw Markji rich-text to validate; required for action=validate and ignored by action=help. Real newlines are significant. Up to 100000 characters.'),
        format: STRING('action=help only: a format id, tag, or alias such as text-style, cloze, audio, card-ref, paragraph, choice, picture, formula, answer-line. Omit or use "all" for every format; "basic" returns general rules and the nesting matrix.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const action = readEnum(args, 'action', 'markji_card_syntax', ['validate', 'help']) ?? 'validate';
      const format = readString(args, 'format', 'markji_card_syntax');
      if (action === 'help') return getSyntaxHelp(format);
      if (format !== undefined) throw new Error('markji_card_syntax: "format" is only supported for action "help"');
      const content = readRawString(args, 'content', 'markji_card_syntax');
      if (content === undefined) throw new Error('markji_card_syntax: "content" is required for action "validate"');
      return validateCardContent(content);
    },
  });

  add({
    name: 'markji_card_create',
    description:
      'Queue a new card in a chapter of a deck. The card keeps a local_* id until the queue is pushed; pass order to place it after the existing cards and grammar_version to override the plugin default. ' +
      'Content must be non-empty Markji rich-text (plain text is valid) of at most 100000 characters. The account has a daily creation cap, so create in small batches. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        deck: STRING('Deck id (Markji OpenAPI deck id) that receives the card.'),
        chapter: STRING('Chapter id (Markji OpenAPI chapter id, or a local_* chapter id queued with markji_chapters_edit).'),
        content: STRING('Card content as Markji rich-text; plain text is valid. Non-empty, at most 100000 characters.'),
        order: INTEGER('Optional insertion position inside the chapter; omitted appends.'),
        grammar_version: INTEGER('Optional grammar_version override; default is the plugin grammarVersion config.'),
      },
      required: ['deck', 'chapter', 'content'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {
        deck: requireString(args, 'deck', 'markji_card_create', 'deck id from markji_decks'),
        chapter: requireString(args, 'chapter', 'markji_card_create', 'chapter id from markji_chapters'),
        content: requireRawString(args, 'content', 'markji_card_create', 'Markji rich-text; plain text is valid'),
      };
      const order = readInteger(args, 'order', 'markji_card_create', 0, 100000);
      if (order !== undefined) payload.order = order;
      const grammarVersion = readInteger(args, 'grammar_version', 'markji_card_create', 1, 99);
      if (grammarVersion !== undefined) payload.grammar_version = grammarVersion;
      return engineMethod(engine, 'createCard')(payload);
    },
  });

  add({
    name: 'markji_card_update',
    description:
      'Queue a content update for one card; the local content changes immediately and the provider update is sent by the next push. ' +
      'grammar_version defaults to the card existing value (or the plugin default when unknown); pass it to override. ' +
      'Content must be non-empty Markji rich-text (plain text is valid) of at most 100000 characters; unchanged content returns changed:false without queueing. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        card: STRING('Card id (Markji OpenAPI id) to update.'),
        content: STRING('New card content as Markji rich-text; plain text is valid. Non-empty, at most 100000 characters.'),
        grammar_version: INTEGER('Optional grammar_version override; the card existing value is reused when known.'),
      },
      required: ['card', 'content'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {
        card: requireString(args, 'card', 'markji_card_update', 'the card id from markji_cards'),
        content: requireRawString(args, 'content', 'markji_card_update', 'Markji rich-text; plain text is valid'),
      };
      const grammarVersion = readInteger(args, 'grammar_version', 'markji_card_update', 1, 99);
      if (grammarVersion !== undefined) payload.grammar_version = grammarVersion;
      return engineMethod(engine, 'updateCard')(payload);
    },
  });

  add({
    name: 'markji_card_archive',
    description:
      'Archive one or more cards without touching the network: each card is moved into its own deck\'s "归档" chapter (created locally on first use) and a "[已归档 YYYY-MM-DD] ..." notice is prepended to its content. ' +
      'The archive is idempotent: cards already in the archive chapter or already starting with the notice are not changed again. Cards with an open conflict are rejected until the conflict is resolved. ' +
      'All changes are queued locally; call markji_sync (or wait for idle auto-sync) to push the archive chapter, content update and move. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        cards: STRING_ARRAY('Card ids to archive (Markji OpenAPI ids, or local ids for unsynced cards). At least one.'),
      },
      required: ['cards'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      return engineMethod(engine, 'archiveCards')({
        cards: requireStringArray(args, 'cards', 'markji_card_archive', 'card ids from markji_cards'),
      });
    },
  });

  add({
    name: 'markji_cards_move',
    description:
      'Queue moving one or more cards to another chapter of the same deck, optionally inserting at order. The cached chapter_id and chapter.card_ids change immediately and the provider move is sent by the next push. ' +
      'Cards created locally are created directly in the target chapter instead of being moved. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        cards: STRING_ARRAY('Card ids to move (Markji OpenAPI ids). At least one.'),
        to_chapter: STRING('Target chapter id (Markji OpenAPI id, or a local_* chapter id queued with markji_chapters_edit).'),
        deck: STRING('Optional deck id; defaults to the deck of the cards.'),
        order: INTEGER('Optional insertion position in the target chapter; omitted appends.'),
      },
      required: ['cards', 'to_chapter'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {
        cards: requireStringArray(args, 'cards', 'markji_cards_move', 'card ids from markji_cards'),
        to_chapter: requireString(args, 'to_chapter', 'markji_cards_move', 'target chapter id from markji_chapters'),
      };
      const deck = readString(args, 'deck', 'markji_cards_move');
      if (deck !== undefined) payload.deck = deck;
      const order = readInteger(args, 'order', 'markji_cards_move', 0, 100000);
      if (order !== undefined) payload.order = order;
      return engineMethod(engine, 'moveCards')(payload);
    },
  });

  add({
    name: 'markji_chapters_edit',
    description:
      'Queue chapter edits without touching the network. action=create makes a local chapter in deck (optional order) that is created on the next push; action=rename queues a new name for chapter; action=sort queues a new chapter order for deck from chapter_ids. ' +
      'A provider revision conflict is recorded as a chapter-revision conflict and the other queued work still runs; local_* ids are remapped to provider ids after creation. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        action: ENUM(CHAPTER_ACTIONS, 'create makes a local chapter, rename renames one chapter, sort reorders every chapter of a deck.'),
        deck: STRING('Deck id: required for create and sort, optional for rename.'),
        chapter: STRING('Chapter id: required for rename, not used by create or sort.'),
        name: STRING('New chapter name: required for create and rename.'),
        order: INTEGER('Optional position for a newly created chapter.'),
        chapter_ids: STRING_ARRAY('New chapter order for action=sort: every chapter id of the deck in the desired order.'),
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const action = requireEnum(args, 'action', 'markji_chapters_edit', CHAPTER_ACTIONS);
      if (action === 'create') {
        const payload = {
          action,
          deck: requireString(args, 'deck', 'markji_chapters_edit', 'deck id that receives the new chapter'),
          name: requireString(args, 'name', 'markji_chapters_edit', 'new chapter name'),
        };
        const order = readInteger(args, 'order', 'markji_chapters_edit', 0, 100000);
        if (order !== undefined) payload.order = order;
        return engineMethod(engine, 'editChapter')(payload);
      }
      if (action === 'rename') {
        const payload = {
          action,
          chapter: requireString(args, 'chapter', 'markji_chapters_edit', 'chapter id to rename'),
          name: requireString(args, 'name', 'markji_chapters_edit', 'new chapter name'),
        };
        const deck = readString(args, 'deck', 'markji_chapters_edit');
        if (deck !== undefined) payload.deck = deck;
        return engineMethod(engine, 'editChapter')(payload);
      }
      const payload = {
        action,
        deck: requireString(args, 'deck', 'markji_chapters_edit', 'deck id to sort'),
        chapter_ids: requireStringArray(args, 'chapter_ids', 'markji_chapters_edit', 'chapter ids of that deck in the desired order'),
      };
      return engineMethod(engine, 'editChapter')(payload);
    },
  });

  add({
    name: 'markji_sync',
    description:
      'Start a Markji sync task and return its handle immediately; the pull/push pipeline runs in the background so this tool never waits for the network (a first pull of a large account can take minutes). mode=pull only pulls and merges; mode=push pulls the decks that contain local work and then pushes queued edits; mode=auto (default) pulls incrementally (all decks when full=true) and then pushes. ' +
      'The result is { task, already_running? }; task carries task_id, status (running|completed|failed|interrupted), stage, progress counters, error and a hint, plus report (pull/push counters, conflict views, errors, cache timestamps) once status is completed. Poll markji_sync_status with task_id for progress. ' +
      'A failed pull fails the task without losing queued edits; a failed per-card push is recorded and never aborts the remaining cards. Before any card write, its pending body is validated as raw Markji syntax and referenced Pic/Audio file ids are batch-queried; invalid content or missing media stays queued and is reported. Conflicts are recorded without discarding local edits. ' +
      'If the host was killed or lost power mid-task, the persisted task becomes interrupted after restart: call markji_sync again with resume=<task_id> to rerun it. A resumed run pulls before pushing and adopts cards/chapters the provider already created, so it does not duplicate them. ' +
      'Only one task runs at a time: calling this while a task is running returns that task with already_running=true. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        mode: ENUM(SYNC_MODES, 'auto pulls then pushes (default), pull only pulls, push pulls decks with local work then pushes.'),
        full: BOOLEAN('Pull every deck instead of only changed decks; applies to the pull phase of mode auto.'),
        resume: STRING('Task id (sync_...) of an interrupted or failed task to resume; omit to start a new task.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {};
      const mode = readEnum(args, 'mode', 'markji_sync', SYNC_MODES);
      if (mode !== undefined) payload.mode = mode;
      const full = readBoolean(args, 'full', 'markji_sync');
      if (full !== undefined) payload.full = full;
      const resume = readString(args, 'resume', 'markji_sync');
      if (resume !== undefined) payload.resume = resume;
      return engineMethod(engine, 'startSync')(payload);
    },
  });

  add({
    name: 'markji_sync_status',
    description:
      'Report background sync task progress and history without touching the network. With task_id the result is { active, tasks: [that task] }; without it the active task plus the newest 10 tasks are returned. Each task view has task_id, status (running|completed|failed|interrupted), stage, progress (decks_total/decks_done, cards, conflicts, push counters, message), timestamps, resume_count, error and the report once completed. ' +
      'An interrupted task means the host stopped mid-run (power loss/crash/kill); resume it with markji_sync resume=<task_id>. A running task is still being processed in the background. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        task_id: STRING('Optional sync task id (sync_...); omit to list the active task and the newest task history.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const taskId = readString(args, 'task_id', 'markji_sync_status');
      return engineMethod(engine, 'syncTaskStatus')(taskId === undefined ? {} : { task_id: taskId });
    },
  });

  add({
    name: 'markji_failures',
    description:
      'List currently unresolved card conflicts and failed cards together with concrete recovery steps. Each conflict includes its id, kind, deck/chapter/card names, local/remote values, a recovery object naming markji_conflict_resolve and its allowed strategies, and the card snippet. ' +
      'Each failed card includes the persisted last push error (or a missing deck/chapter reason), its pending status and a recovery object naming the next tool to call. Recent task-level errors are included for context. ' +
      'The list is read from the local cache; after fixing an item, retry with markji_sync({mode:"push"}) and call markji_failures again until it is empty. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        card: STRING('Optional card id filter.'),
        deck: STRING('Optional deck id filter.'),
        limit: INTEGER('Maximum entries per section (1-200, default 50).'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {};
      const card = readString(args, 'card', 'markji_failures');
      const deck = readString(args, 'deck', 'markji_failures');
      if (card !== undefined) payload.card = card;
      if (deck !== undefined) payload.deck = deck;
      const limit = readInteger(args, 'limit', 'markji_failures', 1, 200);
      if (limit !== undefined) payload.limit = limit;
      return engineMethod(engine, 'failures')(payload);
    },
  });

  add({
    name: 'markji_status',
    description:
      'Report plugin state without a network request: normalized config flags (token presence, base URL, data dir, sync cadence), cache statistics (decks, chapters, cards, conflicts, dirty cards, file path, size, pull and push timestamps), pending edit counts, the open conflicts, the active background sync task, recent tasks and the last sync report or error. ' +
      'Use it to decide whether to sync, to inspect conflicts or running tasks, or to diagnose not_configured and missing-cache errors; markji_sync_status gives full task progress. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run() {
      return engineMethod(engine, 'status')();
    },
  });

  add({
    name: 'markji_conflict_resolve',
    description:
      'Resolve one recorded conflict by id (from markji_status or from markji_sync conflicts). strategy=keep_local keeps the queued local edit for the next push (a card deleted remotely is re-created locally); strategy=keep_remote adopts the remote content and drops the local edit; strategy=use_content applies only to cards and replaces the queued edit with the supplied content so the next push sends it. ' +
      'Returns ok:true and changed:true on success; an unknown id, an already resolved id or a bad strategy is reported as a tool error. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        id: STRING('Conflict id cf_<n> from markji_status or from markji_sync conflicts.'),
        strategy: ENUM(CONFLICT_STRATEGIES, 'keep_local keeps the queued local edit, keep_remote adopts the remote content, use_content queues the supplied content.'),
        content: STRING('Only for strategy=use_content: the replacement content to queue and push; Markji rich-text, plain text is valid.'),
      },
      required: ['id', 'strategy'],
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {
        id: requireString(args, 'id', 'markji_conflict_resolve', 'conflict id from markji_status'),
        strategy: requireEnum(args, 'strategy', 'markji_conflict_resolve', CONFLICT_STRATEGIES),
      };
      const content = readRawString(args, 'content', 'markji_conflict_resolve');
      if (payload.strategy === 'use_content' && content === undefined) {
        throw new Error('markji_conflict_resolve: "content" is required for strategy "use_content"');
      }
      if (content !== undefined) payload.content = content;
      const result = await engineMethod(engine, 'resolveConflict')(payload);
      if (result !== null && typeof result === 'object' && result.ok === false) {
        const reason = result.error;
        const message =
          typeof reason === 'string'
            ? reason
            : reason !== null && typeof reason === 'object' && typeof reason.message === 'string'
              ? reason.message
              : 'conflict resolution failed';
        throw new Error('markji: conflict_resolve_failed: ' + message);
      }
      return result;
    },
  });

  add({
    name: 'markji_file',
    description:
      'Upload a local file to Markji, or query already uploaded file metadata, directly in the cloud; files are not cached. ' +
      'action=upload requires path and accepts an optional deck to attach the file to that deck; action=query requires ids and accepts an optional expires. ' +
      'Supported extensions: png, jpg, jpeg, gif, webp, mp3, wav, ogg, m4a, mp4 and svg; anything else uploads as application/octet-stream. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        action: ENUM(FILE_ACTIONS, 'upload sends a local file, query returns metadata of already uploaded files.'),
        path: STRING('upload only: absolute or relative local file path to upload.'),
        ids: STRING_ARRAY('query only: file ids returned by a previous upload or query. At least one.'),
        expires: INTEGER('query only: optional expiry in seconds passed to the provider file query.'),
        deck: STRING('upload only: optional deck id to attach the file to.'),
      },
      required: ['action'],
      additionalProperties: false,
    },
    timeoutMs: 180000,
    async run(args) {
      const action = requireEnum(args, 'action', 'markji_file', FILE_ACTIONS);
      if (typeof engine.touch === 'function') engine.touch();
      const api = requireClient(client);
      if (action === 'upload') {
        const path = requireString(args, 'path', 'markji_file', 'local file path to upload');
        const deck = readString(args, 'deck', 'markji_file');
        const file = await api.uploadFile(deck === undefined ? { path } : { path, deck_id: deck });
        return { file };
      }
      const payload = { ids: requireStringArray(args, 'ids', 'markji_file', 'file ids from a previous upload or query') };
      const expires = readInteger(args, 'expires', 'markji_file', 0, 2147483647);
      if (expires !== undefined) payload.expires = expires;
      const files = await api.queryFiles(payload);
      return { files };
    },
  });

  if (log !== null) log('debug', 'registered ' + TOOL_NAMES.length + ' tools: ' + TOOL_NAMES.join(', '));

  return function disposeTools() {
    for (let index = disposers.length - 1; index >= 0; index -= 1) {
      try {
        disposers[index]();
      } catch (error) {
        if (log !== null) log('warn', 'tool disposal failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    }
    disposers.length = 0;
  };
}
