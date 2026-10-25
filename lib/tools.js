/**
 * dsh-markji-bridge - model-facing tools.
 *
 * Registers four consolidated action-based tools: markji_decks (decks and
 * chapters), markji_cards (card reads, writes, syntax, archive and move),
 * markji_sync (sync, progress, state, failures and conflict resolution) and
 * markji_file (uncached upload/query). Reads are served from the local cache,
 * every write is queued locally, and markji_sync (or the engine idle auto-sync)
 * pulls remote changes and pushes the queue. Only markji_file talks to the
 * network directly inside a tool call, because uploaded files are not cached.
 *
 * Contract: DESIGN.md, section "lib/tools.js + index.js".
 */

import { validateCardContent } from './card-syntax.js';
import { getSyntaxHelp } from './card-syntax-help.js';
import { startSyncJob } from './jobs.js';
import { SEARCH_MODES } from './search.js';

/** Tool names in registration order. */
export const TOOL_NAMES = ['markji_decks', 'markji_cards', 'markji_sync', 'markji_file'];

const DECK_ACTIONS = ['list', 'get', 'chapter_list', 'chapter_get', 'chapter_create', 'chapter_rename', 'chapter_sort'];
const CARD_ACTIONS = ['list', 'get', 'create', 'update', 'move', 'archive', 'validate', 'syntax_help'];
const FILTER_MODES = [...SEARCH_MODES, 'predicate'];
const SYNC_ACTIONS = ['start', 'progress', 'state', 'failures', 'resolve'];

const SYNC_MODES = ['auto', 'pull', 'push'];
const CHAPTER_ACTIONS = ['create', 'rename', 'sort'];
const CONFLICT_STRATEGIES = ['keep_local', 'keep_remote', 'use_content'];
const FILE_ACTIONS = ['upload', 'query'];
/** Keep one batch response inside the default tool-output budget. */
const MAX_BATCH_ITEMS = 50;

/**
 * Shared semantics appended to every tool description. The descriptions are the
 * agent's only documentation, so the cache / queued edit / sync / conflict /
 * id / content rules are repeated where every tool can see them.
 */
const CACHE_NOTE =
  'Reads use a local cache and writes are queued; markji_sync (or idle auto-sync) pushes them, so reads may be stale. Conflicts appear in markji_sync action=state and are resolved with action=resolve. ' +
  'Ids are Markji OpenAPI ids (local_* only for unsynced new items); card content is Markji rich-text, where plain text is valid.';

const STRING = (description) => ({ type: 'string', description });
const INTEGER = (description) => ({ type: 'integer', description });
const NUMBER = (description) => ({ type: 'number', description, minimum: 0, maximum: 1 });
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

function readNumber(args, key, tool, min, max) {
  const value = args[key];
  if (value === undefined || value === null || value === '') return undefined;
  const number = typeof value === 'number' ? value : Number(String(value).trim());
  if (!Number.isFinite(number)) throw new Error(tool + ': "' + key + '" must be a number');
  if (number < min || number > max) throw new Error(tool + ': "' + key + '" must be between ' + min + ' and ' + max);
  return number;
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

function readQueryOptions(args, tool, payload) {
  const mode = readEnum(args, 'query_mode', tool, FILTER_MODES);
  if (mode !== undefined) payload.query_mode = mode;
  const flags = readString(args, 'regex_flags', tool);
  if (flags !== undefined) payload.regex_flags = flags;
  const minScore = readNumber(args, 'min_score', tool, 0, 1);
  if (minScore !== undefined) payload.min_score = minScore;
  const fields = readStringArray(args, 'fields', tool);
  if (fields !== undefined) payload.fields = fields;
  if (args.predicate !== undefined && args.predicate !== null) {
    if (typeof args.predicate !== 'object' || Array.isArray(args.predicate)) {
      throw new Error(tool + ': "predicate" must be an object');
    }
    payload.predicate = args.predicate;
  }
  return payload;
}

/** Structured predicate tree accepted by list actions. */
const PREDICATE = {
  type: 'object',
  description:
    'Custom condition tree, ANDed with query. Use { field, op, value }, optionally case_sensitive (default false) or flags for regex, or { all: [...] }, { any: [...] }, { not: {...} }. ' +
    'ops: eq, ne, contains, starts_with, ends_with, regex, in, not_in, gt, gte, lt, lte, exists. ' +
    'Allowed fields are resource-specific: decks use id/name/description/card_count/chapter_count/updated_time/created_time/is_private/source/status/missing/folder_id; chapters use id/name/deck_id/revision/order/card_count/updated_time/pending/local/missing; cards use the card fields listed on markji_cards. A field or op not owned by that list fails instead of matching another resource. ' +
    'true/false/null and numeric fields compare natively, strings compare case-insensitively by default, ISO times compare as strings.',
  additionalProperties: true,
};

/** Query parameters shared by every list action. */
const LIST_FILTER_PROPERTIES = {
  query: STRING('Text or phrase to match over the list fields, usually 1-3 words. action=list matches deck name/description/id; action=chapter_list matches chapter name/id. Substring mode is case-insensitive; fuzzy tolerates small edits; regex is a JavaScript pattern. Omit to list everything.'),
  query_mode: ENUM(FILTER_MODES, 'substring (default), fuzzy (approximate; adds score and sorts best-first), regex (JavaScript pattern) or predicate (use the predicate tree).'),
  predicate: PREDICATE,
  fields: STRING_ARRAY('Text fields to search for query. action=list defaults to name/description/id; action=chapter_list defaults to name/id. Only fields owned by that list are accepted; anything else fails with invalid_argument.'),
  regex_flags: STRING('regex mode: JavaScript flags; default "i"; allowed i, m, s, u.'),
  min_score: NUMBER('fuzzy mode: minimum similarity 0-1. Default 0.6; lower it to see weaker matches.'),
};

const CARD_LIST_FILTER_PROPERTIES = {
  ...LIST_FILTER_PROPERTIES,
  query: STRING('Short text or phrase to find, usually 1-3 words. Default: case-insensitive substring over card text, id, deck_name and chapter_name. With query_mode=fuzzy it may differ by small edits; with regex it is a JavaScript pattern. Do not pass several concepts as one space-separated list: fuzzy is for one short phrase. With 3+ terms and no full match, the tool falls back to partial matches instead of returning zero.'),
  query_mode: ENUM(FILTER_MODES, 'substring (default), fuzzy (approximate; adds score and sorts best-first), regex (JavaScript pattern) or predicate (use the predicate tree).'),
};

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

/** Read a non-empty array of raw strings without trimming the bodies. */
function readRawStringList(args, key, tool, maxItems) {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new Error(tool + ': "' + key + '" must be an array of strings');
  if (value.length === 0) throw new Error(tool + ': "' + key + '" must contain at least one item');
  if (value.length > maxItems) throw new Error(tool + ': "' + key + '" supports at most ' + maxItems + ' items per call');
  return value.map((item, index) => {
    if (typeof item !== 'string') throw new Error(tool + ': "' + key + '[' + index + ']" must be a string');
    return item;
  });
}

/** Keep one item's failure from aborting the rest of a batch. */
function errorDetails(error) {
  const source = error !== null && typeof error === 'object' ? error : null;
  const code = source !== null && typeof source.code === 'string' && source.code.trim() !== '' ? source.code.trim() : 'unknown';
  const message =
    source !== null && typeof source.message === 'string' && source.message !== ''
      ? source.message
      : String(error === undefined ? 'unknown error' : error);
  const hint = source !== null && typeof source.hint === 'string' && source.hint.trim() !== '' ? source.hint.trim() : '';
  return { code, message, ...(hint === '' ? {} : { hint }) };
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
    async execute(rawArgs, exec) {
      const args = asArguments(rawArgs);
      try {
        // The plugin starts the engine without blocking apply(); the first tool
        // call waits for the cache load and auto-sync timer instead.
        if (engine !== null && engine !== undefined && typeof engine.ready === 'function') await engine.ready();
        const value = await spec.run(args, exec);
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

  // Build the legacy single-purpose handlers first, then expose them through the
  // four consolidated action-based tools below. They stay in memory only; the
  // old tool names are not registered.
  const legacy = new Map();
  const syncJobs = new Map();
  const SYNC_JOB_CACHE_LIMIT = 100;
  /**
   * Expose a started sync task as a DSH background job owned by the calling
   * session. DSH's jobs UI, job_output and completion notice then provide the
   * user-facing lifecycle instead of a plugin-specific message.
   */
  const attachSyncJob = (result, exec) => {
    const task = result !== null && typeof result === 'object' && result.task !== null && typeof result.task === 'object' ? result.task : null;
    const agent = exec !== null && typeof exec === 'object' ? exec.agent : undefined;
    const owner =
      agent !== null && typeof agent === 'object' && typeof agent.id === 'string' && agent.id !== ''
        ? agent.id
        : agent !== null && typeof agent === 'object' && agent.session !== null && typeof agent.session === 'object' && typeof agent.session.id === 'string'
          ? agent.session.id
          : '';
    if (task === null || typeof task.task_id !== 'string' || owner === '') return result;
    // A running task owned by another DSH process has no local watcher to drive
    // this job; registering one would leave the job running forever. Terminal
    // tasks are safe to expose because watchTask reports them immediately.
    if (
      task.status === 'running' &&
      engine !== null && typeof engine === 'object' &&
      typeof engine.ownsTask === 'function' &&
      engine.ownsTask(task.task_id) !== true
    ) return result;
    const key = owner + '|' + task.task_id + '|' + String(task.resume_count ?? 0);
    const existing = syncJobs.get(key);
    if (existing !== undefined) return { ...result, job_id: existing };
    let jobs;
    try {
      jobs = typeof ctx.get === 'function' ? ctx.get('jobs') : undefined;
    } catch {
      jobs = undefined;
    }
    if (jobs === undefined) return result;
    const toolCall =
      exec !== null && typeof exec === 'object' && typeof exec.callId === 'string'
        ? { callId: exec.callId, ...(typeof exec.rootCallId === 'string' ? { rootCallId: exec.rootCallId } : {}) }
        : undefined;
    const jobId = startSyncJob({ jobs, engine, owner, task, toolCall, log });
    if (jobId === null) return result;
    syncJobs.set(key, jobId);
    if (syncJobs.size > SYNC_JOB_CACHE_LIMIT) {
      const oldest = syncJobs.keys().next().value;
      if (oldest !== undefined) syncJobs.delete(oldest);
    }
    return { ...result, job_id: jobId };
  };
  const add = (spec) => {
    legacy.set(spec.name, spec);
  };

  add({
    name: 'markji_decks',
    description:
      'List Markji decks and folders from the local cache, optionally filtered. Each folder has id, name, optional parent_id and deck_count; each deck has id, name, card_count, chapter_count and optional folder_id, plus is_private/source/status/missing only when noteworthy. ' +
      'Deck filters are deck-only: query/fields cover name/description/id, and predicate accepts id/name/description/card_count/chapter_count/updated_time/created_time/is_private/source/status/missing/folder_id. Unsupported fields are rejected. scope=all lists every deck, scope=folder with folder_id narrows to one folder. ' +
      'refresh=true forces a pull before reading; otherwise the cache is reused until its pull TTL expires. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        refresh: BOOLEAN('Force a pull before reading instead of using the cache until its pull TTL expires.'),
        folder_id: STRING('Only list decks of this folder (a Markji OpenAPI folder id from the folders list).'),
        scope: ENUM(['all', 'folder'], 'all (default) or folder; folder requires folder_id.'),
        ...LIST_FILTER_PROPERTIES,
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {};
      const folderId = readString(args, 'folder_id', 'markji_decks');
      if (folderId !== undefined) payload.folder_id = folderId;
      const scope = readEnum(args, 'scope', 'markji_decks', ['all', 'folder']);
      if (scope !== undefined) payload.scope = scope;
      const query = readString(args, 'query', 'markji_decks');
      if (query !== undefined) payload.query = query;
      readQueryOptions(args, 'markji_decks', payload);
      payload.refresh = readBoolean(args, 'refresh', 'markji_decks') === true;
      return engineMethod(engine, 'listDecks')(payload);
    },
  });

  add({
    name: 'markji_chapters',
    description:
      'List the chapters of one deck, or of every cached deck when deck is omitted, from the local cache, optionally filtered. Each chapter has id, name and card_count, plus pending, local or missing only when relevant. When a deck is not cached yet, run markji_sync mode=pull full=true first. ' +
      'Chapter filters are chapter-only: query/fields cover name/id, and predicate accepts id/name/deck_id/revision/order/card_count/updated_time/pending/local/missing. Chapters have no description and no deck_name predicate; use scope=deck to narrow by parent deck. Unsupported fields are rejected. scope=all lists every deck, scope=deck with deck narrows to one deck. ' +
      'refresh=true forces a pull before reading; otherwise the cache is reused until its pull TTL expires. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        deck: STRING('Deck id (Markji OpenAPI id). Omit to list the chapters of every cached deck.'),
        scope: ENUM(['all', 'deck'], 'all (default) or deck; deck requires deck.'),
        ...LIST_FILTER_PROPERTIES,
        refresh: BOOLEAN('Force a pull before reading instead of using the cache until its pull TTL expires.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {};
      const deck = readString(args, 'deck', 'markji_chapters');
      if (deck !== undefined) payload.deck = deck;
      const scope = readEnum(args, 'scope', 'markji_chapters', ['all', 'deck']);
      if (scope !== undefined) payload.scope = scope;
      const query = readString(args, 'query', 'markji_chapters');
      if (query !== undefined) payload.query = query;
      readQueryOptions(args, 'markji_chapters', payload);
      payload.refresh = readBoolean(args, 'refresh', 'markji_chapters') === true;
      return engineMethod(engine, 'listChapters')(payload);
    },
  });

  add({
    name: 'markji_cards',
    description:
      'List cached cards, optionally filtered by scope, names, updated time, query and predicate. Substring matches the card plain text and id by default (formatting tags, media and embedded base64 excluded); query_mode=fuzzy tolerates small edits, regex treats query as a JavaScript pattern, and predicate filters on structured conditions. ' +
      'Returns total, offset, limit, has_more and compact CardSummary entries: id, deck_name, chapter_name, snippet, and status only when it is not synced. Fuzzy adds score; fuzzy/regex add matched_by; a partial fuzzy fallback adds partial/fallback_terms and per-card matched_terms. Use action=get for full content and timestamps. limit defaults to 50 and is capped at 200; page with offset. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        scope: ENUM(['all', 'deck', 'chapter'], 'all (default), deck (requires deck) or chapter (requires chapter).'),
        deck: STRING('scope=deck / chapter: only cards of this deck (Markji OpenAPI deck id).'),
        chapter: STRING('scope=chapter: only cards of this chapter (Markji OpenAPI chapter id, or a local_* chapter id before its first push).'),
        ...CARD_LIST_FILTER_PROPERTIES,
        deck_name: STRING('Case-insensitive substring of the deck name.'),
        chapter_name: STRING('Case-insensitive substring of the chapter name.'),
        updated_after: STRING('Only cards updated at or after this time: ISO 8601 (2026-10-01T08:00:00Z) or epoch milliseconds.'),
        updated_before: STRING('Only cards updated at or before this time: ISO 8601 or epoch milliseconds.'),
        limit: INTEGER('Maximum cards to return, 1-200. Default 50.'),
        offset: INTEGER('Number of matching cards to skip, for paging. Default 0.'),
        refresh: BOOLEAN('Pull changed decks before listing. Default false.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const payload = {};
      const scope = readEnum(args, 'scope', 'markji_cards', ['all', 'deck', 'chapter']);
      if (scope !== undefined) payload.scope = scope;
      const deck = readString(args, 'deck', 'markji_cards');
      if (deck !== undefined) payload.deck = deck;
      const chapter = readString(args, 'chapter', 'markji_cards');
      if (chapter !== undefined) payload.chapter = chapter;
      const deckName = readString(args, 'deck_name', 'markji_cards');
      if (deckName !== undefined) payload.deck_name = deckName;
      const chapterName = readString(args, 'chapter_name', 'markji_cards');
      if (chapterName !== undefined) payload.chapter_name = chapterName;
      if (args.updated_after !== undefined && args.updated_after !== null && args.updated_after !== '') payload.updated_after = args.updated_after;
      if (args.updated_before !== undefined && args.updated_before !== null && args.updated_before !== '') payload.updated_before = args.updated_before;
      const query = readString(args, 'query', 'markji_cards');
      if (query !== undefined) payload.query = query;
      readQueryOptions(args, 'markji_cards', payload);
      const limit = readInteger(args, 'limit', 'markji_cards', 1, 200);
      if (limit !== undefined) payload.limit = limit;
      const offset = readInteger(args, 'offset', 'markji_cards', 0, 1000000);
      if (offset !== undefined) payload.offset = offset;
      if (readBoolean(args, 'refresh', 'markji_cards') === true) payload.refresh = true;
      return engineMethod(engine, 'listCards')(payload);
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
    name: 'markji_cards_get',
    description:
      'Read several cached cards in one call by id. cards holds the card details in the requested order; unknown ids are listed in missing, so one bad id does not abort the batch. A single refresh is attempted when any id is missing. ' +
      'include_text=false by default omits the redundant plain-text view; pass true when it is needed. Duplicate ids are collapsed. At most ' + MAX_BATCH_ITEMS + ' unique ids per call; use smaller batches when the rendered output would be truncated. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        cards: STRING_ARRAY('Card ids to read (Markji OpenAPI ids or local_* ids), up to ' + MAX_BATCH_ITEMS + ' unique ids.'),
        include_text: BOOLEAN('Include the plain-text view (formatting/media removed) for each card. Default false to keep batch output small.'),
      },
      required: ['cards'],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async run(args) {
      const cards = [...new Set(requireStringArray(args, 'cards', 'markji_cards_get', 'card ids from markji_cards'))];
      if (cards.length > MAX_BATCH_ITEMS) {
        throw new Error('markji_cards_get: "cards" supports at most ' + MAX_BATCH_ITEMS + ' ids per call');
      }
      const includeText = readBoolean(args, 'include_text', 'markji_cards_get') === true;
      const result = await engineMethod(engine, 'getCards')({ cards });
      if (!includeText && Array.isArray(result.cards)) {
        for (const card of result.cards) {
          if (card && typeof card === 'object') delete card.text;
        }
      }
      return result;
    },
  });

  add({
    name: 'markji_card_syntax',
    description:
      'Validate raw Markji rich-text before creating or updating a card, or return static syntax help. ' +
      'action=validate (default) checks the exact content and returns ok, errors, warnings, stats and the media file ids it found; it never generates or rewrites content. ' +
      'For batch validation pass contents (array of raw bodies) or cards (array of cached card ids); each item gets its own result, one bad item does not abort the others, and no provider media query is made. ' +
      'action=help returns the raw Markji syntax reference; omit format for every format, or pass a format id, tag, or alias (text-style, cloze, audio, card-ref, paragraph, choice, picture, formula, answer-line) for one entry. ' +
      'markji_sync validates every queued card again and additionally checks those media ids against Markji before pushing. ' +
      'Run validate first, fix every error, then call markji_card_create or markji_card_update with the same content.',
    parameters: {
      type: 'object',
      properties: {
        action: ENUM(['validate', 'help'], 'validate checks content (default); help returns static syntax documentation and does not need content.'),
        content: STRING('Raw Markji rich-text to validate; for action=validate pass exactly one of content, contents or cards. Up to 100000 characters.'),
        contents: {
          type: 'array',
          items: { type: 'string' },
          description: 'Several raw Markji bodies to validate in one call, up to ' + MAX_BATCH_ITEMS + '. Each item is validated independently; real newlines are significant.',
        },
        cards: STRING_ARRAY('Cached card ids whose effective content (pending edit when present) to validate, up to ' + MAX_BATCH_ITEMS + ' unique ids.'),
        format: STRING('action=help only: a format id, tag, or alias such as text-style, cloze, audio, card-ref, paragraph, choice, picture, formula, answer-line. Omit or use "all" for every format; "basic" returns general rules and the nesting matrix.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async run(args) {
      const action = readEnum(args, 'action', 'markji_card_syntax', ['validate', 'help']) ?? 'validate';
      const format = readString(args, 'format', 'markji_card_syntax');
      if (action === 'help') return getSyntaxHelp(format);
      if (format !== undefined) throw new Error('markji_card_syntax: "format" is only supported for action "help"');
      const content = readRawString(args, 'content', 'markji_card_syntax');
      const contents = readRawStringList(args, 'contents', 'markji_card_syntax', MAX_BATCH_ITEMS);
      const cards = readStringArray(args, 'cards', 'markji_card_syntax');
      const modes = [content !== undefined, contents !== undefined, cards !== undefined].filter(Boolean).length;
      if (modes === 0) throw new Error('markji_card_syntax: pass one of "content", "contents", or "cards" for action "validate"');
      if (modes > 1) throw new Error('markji_card_syntax: pass only one of "content", "contents", or "cards"');
      if (content !== undefined) return validateCardContent(content);
      if (contents !== undefined) {
        const results = contents.map((body, index) => ({ index, content_length: body.length, ...validateCardContent(body) }));
        const valid = results.filter((item) => item.ok === true).length;
        return {
          ok: valid === results.length,
          action: 'validate',
          mode: 'batch',
          source: 'contents',
          total: results.length,
          valid,
          invalid: results.length - valid,
          results,
        };
      }
      const uniqueCards = [...new Set(cards)];
      if (uniqueCards.length === 0) throw new Error('markji_card_syntax: "cards" must contain at least one id');
      if (uniqueCards.length > MAX_BATCH_ITEMS) {
        throw new Error('markji_card_syntax: "cards" supports at most ' + MAX_BATCH_ITEMS + ' ids per call');
      }
      const batch = await engineMethod(engine, 'getCards')({ cards: uniqueCards });
      const cardById = new Map(batch.cards.map((card) => [card.id, card]));
      const results = uniqueCards.map((cardId, index) => {
        const card = cardById.get(cardId);
        if (!card) {
          return { index, card_id: cardId, ok: false, error: { code: 'unknown_card', message: 'Unknown card: ' + cardId + ' is not in the local cache' } };
        }
        const pending = card.pending !== null && typeof card.pending === 'object' && typeof card.pending.content === 'string';
        const body = pending ? card.pending.content : card.content;
        const validation = validateCardContent(body);
        return {
          index,
          card_id: card.id,
          ok: validation.ok,
          content_source: pending ? 'pending' : 'content',
          content_length: typeof body === 'string' ? body.length : null,
          errors: validation.errors,
          warnings: validation.warnings,
          stats: validation.stats,
          media: validation.media,
        };
      });
      const valid = results.filter((item) => item.ok === true).length;
      const syntaxInvalid = results.filter((item) => item.ok !== true && item.error === undefined).length;
      return {
        ok: valid === results.length,
        action: 'validate',
        mode: 'batch',
        source: 'cards',
        total: results.length,
        valid,
        invalid: results.length - valid,
        missing: Array.isArray(batch.missing) ? batch.missing.length : 0,
        syntax_invalid: syntaxInvalid,
        results,
      };
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
    name: 'markji_cards_create',
    description:
      'Queue several new cards in one call, including cards in different chapters or decks. Top-level deck and chapter are defaults; each item may set its own target. Each card keeps a local_* id until the next push; order and grammar_version can be set per item (order is relative to that item target chapter). ' +
      'Each item is queued independently: a bad item is reported per item and does not abort the rest, so a partial batch is possible. Cards are created in array order. ' +
      'Content must be non-empty Markji rich-text (plain text is valid) of at most 100000 characters. The account has a daily creation cap, so create reasonable batches and sync between imports. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        deck: STRING('Optional default deck id (Markji OpenAPI deck id) for items that do not set their own deck.'),
        chapter: STRING('Optional default chapter id for items that do not set their own chapter.'),
        cards: {
          type: 'array',
          description: 'Cards to create, up to ' + MAX_BATCH_ITEMS + ' items; order is preserved in the result.',
          items: {
            type: 'object',
            properties: {
              content: STRING('Card content as Markji rich-text; plain text is valid. Non-empty, at most 100000 characters.'),
              deck: STRING('Optional target deck id for this item; overrides the top-level deck.'),
              chapter: STRING('Optional target chapter id for this item; overrides the top-level chapter.'),
              order: INTEGER('Optional insertion position inside this item target chapter.'),
              grammar_version: INTEGER('Optional grammar_version override for this card.'),
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
      },
      required: ['cards'],
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async run(args) {
      const defaultDeck = readString(args, 'deck', 'markji_cards_create');
      const defaultChapter = readString(args, 'chapter', 'markji_cards_create');
      if (!Array.isArray(args.cards)) throw new Error('markji_cards_create: "cards" must be an array');
      if (args.cards.length === 0) throw new Error('markji_cards_create: "cards" must contain at least one item');
      if (args.cards.length > MAX_BATCH_ITEMS) {
        throw new Error('markji_cards_create: "cards" supports at most ' + MAX_BATCH_ITEMS + ' items per call');
      }
      const createCard = engineMethod(engine, 'createCard');
      const results = [];
      for (let index = 0; index < args.cards.length; index += 1) {
        try {
          const item = args.cards[index];
          if (item === null || typeof item !== 'object' || Array.isArray(item)) {
            throw new Error('markji_cards_create: "cards[' + index + ']" must be an object');
          }
          const itemDeck = readString(item, 'deck', 'markji_cards_create');
          const itemChapter = readString(item, 'chapter', 'markji_cards_create');
          const deck = itemDeck === undefined ? defaultDeck : itemDeck;
          const chapter = itemChapter === undefined ? defaultChapter : itemChapter;
          if (deck === undefined || chapter === undefined) {
            throw new Error(
              'markji_cards_create: "cards[' + index + ']" needs deck and chapter, set on the item or as top-level defaults',
            );
          }
          const payload = {
            deck,
            chapter,
            content: requireRawString(item, 'content', 'markji_cards_create', 'Markji rich-text; plain text is valid'),
          };
          const order = readInteger(item, 'order', 'markji_cards_create', 0, 100000);
          if (order !== undefined) payload.order = order;
          const grammarVersion = readInteger(item, 'grammar_version', 'markji_cards_create', 1, 99);
          if (grammarVersion !== undefined) payload.grammar_version = grammarVersion;
          results.push({ index, ...(await createCard(payload)) });
        } catch (error) {
          results.push({ index, ok: false, error: errorDetails(error) });
        }
      }
      const failed = results.filter((item) => item.ok !== true).length;
      return {
        ok: failed === 0,
        action: 'create',
        mode: 'batch',
        deck_id: defaultDeck === undefined ? null : defaultDeck,
        chapter_id: defaultChapter === undefined ? null : defaultChapter,
        total: results.length,
        created: results.length - failed,
        failed,
        partial: failed > 0 && failed < results.length,
        results,
      };
    },
  });

  add({
    name: 'markji_card_update',
    description:
      'Queue a content update for one card; the local content changes immediately and the provider update is sent by the next push. ' +
      'grammar_version defaults to the card existing value (or the plugin default when unknown); pass it to override. ' +
      'Content must be non-empty Markji rich-text (plain text is valid) of at most 100000 characters; unchanged content returns changed:false without queueing. ' +
      'For batch edits pass updates (array of {card, content, grammar_version?}) instead of card/content; each item is queued independently and one bad item does not abort the others, so a partial batch is reported per item. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        card: STRING('Card id (Markji OpenAPI id) to update in single-card mode.'),
        content: STRING('New card content as Markji rich-text; plain text is valid. Non-empty, at most 100000 characters.'),
        grammar_version: INTEGER('Optional grammar_version override; the card existing value is reused when known.'),
        updates: {
          type: 'array',
          description: 'Batch updates, up to ' + MAX_BATCH_ITEMS + ' items. Mutually exclusive with card/content/grammar_version. Results preserve this order and report each item separately.',
          items: {
            type: 'object',
            properties: {
              card: STRING('Card id to update.'),
              content: STRING('New Markji rich-text; plain text is valid.'),
              grammar_version: INTEGER('Optional grammar_version override for this card.'),
            },
            required: ['card', 'content'],
            additionalProperties: false,
          },
        },
      },
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async run(args) {
      if (args.updates !== undefined) {
        if (args.card !== undefined || args.content !== undefined || args.grammar_version !== undefined) {
          throw new Error('markji_card_update: pass either card/content or updates, not both');
        }
        if (!Array.isArray(args.updates)) throw new Error('markji_card_update: "updates" must be an array');
        if (args.updates.length === 0) throw new Error('markji_card_update: "updates" must contain at least one item');
        if (args.updates.length > MAX_BATCH_ITEMS) {
          throw new Error('markji_card_update: "updates" supports at most ' + MAX_BATCH_ITEMS + ' items per call');
        }
        const updateCard = engineMethod(engine, 'updateCard');
        const results = [];
        const seen = new Set();
        for (let index = 0; index < args.updates.length; index += 1) {
          let cardId = null;
          try {
            const item = args.updates[index];
            if (item === null || typeof item !== 'object' || Array.isArray(item)) {
              throw new Error('markji_card_update: "updates[' + index + ']" must be an object');
            }
            cardId = requireString(item, 'card', 'markji_card_update', 'the card id from markji_cards');
            if (seen.has(cardId)) throw new Error('markji_card_update: duplicate card id in "updates": ' + cardId);
            const payload = {
              card: cardId,
              content: requireRawString(item, 'content', 'markji_card_update', 'Markji rich-text; plain text is valid'),
            };
            const grammarVersion = readInteger(item, 'grammar_version', 'markji_card_update', 1, 99);
            if (grammarVersion !== undefined) payload.grammar_version = grammarVersion;
            seen.add(cardId);
            results.push({ index, ...(await updateCard(payload)) });
          } catch (error) {
            results.push({ index, card_id: cardId, ok: false, error: errorDetails(error) });
          }
        }
        const failed = results.filter((item) => item.ok !== true).length;
        const updated = results.filter((item) => item.ok === true && item.changed === true).length;
        const unchanged = results.filter((item) => item.ok === true && item.changed === false).length;
        return {
          ok: failed === 0,
          action: 'update',
          mode: 'batch',
          total: results.length,
          updated,
          unchanged,
          failed,
          partial: failed > 0 && failed < results.length,
          results,
        };
      }
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
      'The result is { task, job_id?, already_running? }; task carries task_id, status (running|completed|failed|interrupted), stage, nonzero progress counters, error and a hint, plus a compact report (pull/push counters, conflicts and errors) once status is completed. When DSH background jobs are available (dsh-tool-jobs loaded) and this call came from a live agent, the task is also registered as a DSH job owned by that session: job_id is returned, its progress appears in the background-jobs list, job_output reads it, and DSH sends the standard completion notice to the session. Killing that job cancels the task at its next checkpoint and leaves it resumable. Poll markji_sync action=progress with task_id when no job is available. ' +
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
    async run(args, exec) {
      const payload = {};
      const mode = readEnum(args, 'mode', 'markji_sync', SYNC_MODES);
      if (mode !== undefined) payload.mode = mode;
      const full = readBoolean(args, 'full', 'markji_sync');
      if (full !== undefined) payload.full = full;
      const resume = readString(args, 'resume', 'markji_sync');
      if (resume !== undefined) payload.resume = resume;
      const result = await engineMethod(engine, 'startSync')(payload);
      return attachSyncJob(result, exec);
    },
  });

  add({
    name: 'markji_sync_status',
    description:
      'Report background sync task progress and history without touching the network. With task_id the result is { task } for that task only; without it the result is { active, tasks } with the active task and newest 3 tasks. Each task view has task_id, status (running|completed|failed|interrupted), stage, timestamps, nonzero progress counters, resume_count, an error when present and a compact report once completed. ' +
      'An interrupted task means the host stopped mid-run (power loss/crash/kill); resume it with markji_sync resume=<task_id>. A running task is still being processed in the background. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        task_id: STRING('Optional sync task id (sync_...); with it return only { task }, otherwise return the active task and newest 3 tasks.'),
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
      'Each failed card includes the persisted last push error (or a missing deck/chapter reason), its status and a recovery object naming the next tool to call. Recent task-level errors are included for context. ' +
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
      'Report plugin state without a network request: version and configured flag, cache file and counts, nonzero pending edit counts, open conflicts, the active sync task, the newest 3 compact task views, the last sync summary and the last error. ' +
      'Use it to decide whether to sync, to inspect conflicts or running tasks, or to diagnose not_configured and missing-cache errors; markji_sync action=progress gives task progress. ' +
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
      'Files are uploaded or queried directly in the cloud, not cached or queued.',
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

  const disposers = [];
  const register = (spec) => {
    disposers.push(registerTool(ctx, engine, config, spec));
  };

  const invoke = async (name, args, prefix, exec) => {
    const spec = legacy.get(name);
    if (spec === undefined) throw new Error('markji: internal_operation_missing: ' + name);
    try {
      return await spec.run(args, exec);
    } catch (error) {
      if (error instanceof Error) {
        error.message = error.message.replace(/^markji_[a-z0-9_]+:/, prefix + ':');
      }
      throw error;
    }
  };

  register({
    name: 'markji_decks',
    description:
      'Deck and chapter operations in one tool. action=list (default) lists folders and decks; action=get returns one deck with its chapters; action=chapter_list lists chapters for one deck or for every cached deck; action=chapter_get returns one chapter and, with with_cards=true, its card summaries; action=chapter_create, chapter_rename and chapter_sort queue local chapter edits. ' +
      'action=list filters deck-only fields (query name/description/id; predicate deck columns). action=chapter_list filters chapter-only fields (query name/id; predicate chapter columns, no description or deck_name). Unsupported fields fail with invalid_argument. scope restricts decks or chapters. ' +
      'refresh=true forces a pull before reads. Chapter deletion is not supported by the provider API. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        action: ENUM(DECK_ACTIONS, 'list (default), get, chapter_list, chapter_get, chapter_create, chapter_rename or chapter_sort.'),
        deck: STRING('Deck id. Required for action=get, chapter_create, and chapter_sort; optional for chapter_list, chapter_get and chapter_rename.'),
        chapter: STRING('Chapter id for chapter_get and chapter_rename.'),
        folder_id: STRING('action=list only: only list decks of this folder.'),
        scope: ENUM(['all', 'folder', 'deck'], 'action=list: all (default) or folder (requires folder_id); action=chapter_list: all (default) or deck (requires deck).'),
        ...LIST_FILTER_PROPERTIES,
        refresh: BOOLEAN('Force a pull before reading instead of using the cache until its pull TTL expires.'),
        with_cards: BOOLEAN('action=chapter_get only: include card summaries of that chapter.'),
        name: STRING('action=chapter_create / chapter_rename: chapter name.'),
        order: INTEGER('action=chapter_create only: optional position for the new chapter.'),
        chapter_ids: STRING_ARRAY('action=chapter_sort: every chapter id of the deck in the desired order.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args) {
      const action = readEnum(args, 'action', 'markji_decks', DECK_ACTIONS) ?? 'list';
      if (action === 'list') return invoke('markji_decks', args, 'markji_decks (action=list)');
      if (action === 'get') {
        const payload = { deck: requireString(args, 'deck', 'markji_decks', 'deck id from action=list') };
        const refresh = readBoolean(args, 'refresh', 'markji_decks');
        if (refresh !== undefined) payload.refresh = refresh;
        return engineMethod(engine, 'getDeck')(payload);
      }
      if (action === 'chapter_list') return invoke('markji_chapters', args, 'markji_decks (action=chapter_list)');
      if (action === 'chapter_get') {
        const payload = { chapter: requireString(args, 'chapter', 'markji_decks', 'chapter id from action=chapter_list') };
        const deck = readString(args, 'deck', 'markji_decks');
        if (deck !== undefined) payload.deck = deck;
        const withCards = readBoolean(args, 'with_cards', 'markji_decks');
        if (withCards !== undefined) payload.with_cards = withCards;
        const refresh = readBoolean(args, 'refresh', 'markji_decks');
        if (refresh !== undefined) payload.refresh = refresh;
        return engineMethod(engine, 'getChapter')(payload);
      }
      return invoke(
        'markji_chapters_edit',
        { ...args, action: action.slice('chapter_'.length) },
        'markji_decks (action=' + action + ')',
      );
    },
  });

  register({
    name: 'markji_cards',
    description:
      'Card operations in one tool. action=list (default) lists cached cards with optional scope, query/query_mode/predicate, name and updated-time filters; action=get reads one or more cards by id; action=create queues new cards from new_cards (each item may set deck/chapter); action=update edits one card (card + content) or several (updates); action=move moves cards to another chapter; action=archive archives cards; action=validate checks raw content or cached cards; action=syntax_help returns raw Markji syntax help. list returns compact summaries (id, deck_name, chapter_name, snippet, status only when not synced); action=get returns full content. ' +
      'Card filters keep the wider card field set, including content, cloud, status and timestamps; fields not owned by cards fail. For get/move/archive/validate use cards for card ids; for create use new_cards; for update use updates. Batch writes are per-item: a bad item is reported without aborting the rest, and successful items still need markji_sync (action=start). ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        action: ENUM(CARD_ACTIONS, 'list (default), get, create, update, move, archive, validate or syntax_help.'),
        deck: STRING('list: scope=deck target; create: default deck for items without their own target; move: optional deck id of the cards.'),
        chapter: STRING('list: scope=chapter target; create: default chapter for items without their own target.'),
        ...CARD_LIST_FILTER_PROPERTIES,
        scope: ENUM(['all', 'deck', 'chapter'], 'list: all (default), deck (requires deck) or chapter (requires chapter).'),
        deck_name: STRING('list: case-insensitive substring of the deck name.'),
        chapter_name: STRING('list: case-insensitive substring of the chapter name.'),
        updated_after: STRING('list: ISO 8601 time or epoch milliseconds lower bound.'),
        updated_before: STRING('list: ISO 8601 time or epoch milliseconds upper bound.'),
        limit: INTEGER('list: maximum results, 1-200; default 50.'),
        offset: INTEGER('list: number of matches to skip.'),
        refresh: BOOLEAN('list: pull changed decks before reading.'),
        card: STRING('get: one card id. update: single-card id with content.'),
        cards: STRING_ARRAY('get/move/archive/validate: card ids. At least one where required.'),
        include_text: BOOLEAN('get: include the plain-text view (default false).'),
        new_cards: {
          type: 'array',
          description: 'create: cards to create, up to ' + MAX_BATCH_ITEMS + ' items; each item may set its own deck and chapter.',
          items: {
            type: 'object',
            properties: {
              content: STRING('Card content as Markji rich-text; plain text is valid. Non-empty, at most 100000 characters.'),
              deck: STRING('Optional target deck id; overrides the top-level deck.'),
              chapter: STRING('Optional target chapter id; overrides the top-level chapter.'),
              order: INTEGER('Optional insertion position inside the item target chapter.'),
              grammar_version: INTEGER('Optional grammar_version override.'),
            },
            required: ['content'],
            additionalProperties: false,
          },
        },
        content: STRING('update: single-card content; validate: one raw body.'),
        contents: STRING_ARRAY('validate: several raw bodies, up to ' + MAX_BATCH_ITEMS + '.'),
        updates: {
          type: 'array',
          description: 'update: batch edits, up to ' + MAX_BATCH_ITEMS + ' items.',
          items: {
            type: 'object',
            properties: {
              card: STRING('Card id to update.'),
              content: STRING('New Markji rich-text; plain text is valid.'),
              grammar_version: INTEGER('Optional grammar_version override.'),
            },
            required: ['card', 'content'],
            additionalProperties: false,
          },
        },
        to_chapter: STRING('move: target chapter id.'),
        order: INTEGER('move only: insertion position in the target chapter; create items use their own order.'),
        grammar_version: INTEGER('update single: optional grammar_version override.'),
        format: STRING('syntax_help: format id, tag or alias; omit or use "all".'),
      },
      additionalProperties: false,
    },
    timeoutMs: 120000,
    async run(args) {
      const action = readEnum(args, 'action', 'markji_cards', CARD_ACTIONS) ?? 'list';
      if (action === 'list') return invoke('markji_cards', args, 'markji_cards (action=list)');
      if (action === 'get') {
        const ids = [];
        const card = readString(args, 'card', 'markji_cards');
        if (card !== undefined) ids.push(card);
        const cards = readStringArray(args, 'cards', 'markji_cards');
        if (cards !== undefined) ids.push(...cards);
        if (ids.length === 0) throw new Error('markji_cards: action=get needs "card" or "cards"');
        const payload = { cards: ids };
        const includeText = readBoolean(args, 'include_text', 'markji_cards');
        if (includeText !== undefined) payload.include_text = includeText;
        return invoke('markji_cards_get', payload, 'markji_cards (action=get)');
      }
      if (action === 'create') {
        if (args.new_cards === undefined) throw new Error('markji_cards: action=create requires "new_cards" (an array)');
        return invoke('markji_cards_create', { ...args, cards: args.new_cards }, 'markji_cards (action=create)');
      }
      if (action === 'update') return invoke('markji_card_update', args, 'markji_cards (action=update)');
      if (action === 'move') return invoke('markji_cards_move', args, 'markji_cards (action=move)');
      if (action === 'archive') return invoke('markji_card_archive', args, 'markji_cards (action=archive)');
      if (action === 'validate') return invoke('markji_card_syntax', { ...args, action: 'validate' }, 'markji_cards (action=validate)');
      const payload = { action: 'help' };
      const format = readString(args, 'format', 'markji_cards');
      if (format !== undefined) payload.format = format;
      return invoke('markji_card_syntax', payload, 'markji_cards (action=syntax_help)');
    },
  });

  register({
    name: 'markji_sync',
    description:
      'Sync and plugin operations in one tool. action=start (default) starts a background pull/push task and returns its handle; action=progress reports task progress and history; action=state reports plugin state, cache statistics, pending edits and open conflicts; action=failures lists unresolved conflicts and failed cards with recovery steps; action=resolve resolves one conflict by id. ' +
      'start never waits for the network: mode=pull only pulls, mode=push pulls decks with local work then pushes, mode=auto (default) pulls incrementally then pushes. Use resume=<task_id> to rerun an interrupted task. Only one task runs at a time. When DSH background jobs are available, start also registers a job owned by the calling session and returns job_id; the job appears in the background-jobs list, job_output reads it, DSH sends its completion notice, and killing it cancels the task at the next checkpoint. ' +
      CACHE_NOTE,
    parameters: {
      type: 'object',
      properties: {
        action: ENUM(SYNC_ACTIONS, 'start (default), progress, state, failures or resolve.'),
        mode: ENUM(SYNC_MODES, 'start: auto (default), pull or push.'),
        full: BOOLEAN('start: pull every deck instead of only changed decks.'),
        resume: STRING('start: task id (sync_...) of an interrupted or failed task to resume.'),
        task_id: STRING('progress: optional sync task id; with it return only {task}, omit it to return the active task and newest 3 tasks.'),
        card: STRING('failures: optional card id filter.'),
        deck: STRING('failures: optional deck id filter.'),
        limit: INTEGER('failures: maximum entries per section (1-200, default 50).'),
        id: STRING('resolve: conflict id cf_<n> from action=state or a completed start report.'),
        strategy: ENUM(CONFLICT_STRATEGIES, 'resolve: keep_local, keep_remote or use_content (cards only).'),
        content: STRING('resolve + use_content: replacement Markji rich-text to queue and push.'),
      },
      additionalProperties: false,
    },
    timeoutMs: 60000,
    async run(args, exec) {
      const action = readEnum(args, 'action', 'markji_sync', SYNC_ACTIONS) ?? 'start';
      if (action === 'start') return invoke('markji_sync', args, 'markji_sync (action=start)', exec);
      if (action === 'progress') return invoke('markji_sync_status', args, 'markji_sync (action=progress)');
      if (action === 'state') return invoke('markji_status', {}, 'markji_sync (action=state)');
      if (action === 'failures') return invoke('markji_failures', args, 'markji_sync (action=failures)');
      return invoke('markji_conflict_resolve', args, 'markji_sync (action=resolve)');
    },
  });

  register(legacy.get('markji_file'));

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
