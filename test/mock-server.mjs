/**
 * In-memory Markji OpenAPI mock server for end-to-end tests (Lead-owned).
 *
 * It implements the subset of /open/api/v1/markji/* that the plugin uses, with the
 * live response envelope, auth, revisions, and request log. Tests use it to prove the
 * real HTTP client + store + engine work together without touching the user's account.
 *
 * Usage:
 *   const mock = await startMockMarkji();
 *   mock.url            // http://127.0.0.1:<port>   (pass as config.baseUrl)
 *   mock.token
 *   mock.state          // inspect entities
 *   mock.requests       // [{ method, path, body }]
 *   mock.remoteEditCard(cardId, content)   // simulate a change made in the Markji app
 *   mock.remoteDeleteCard(cardId)
 *   mock.remoteDeleteChapter(chapterId)
 *   mock.remoteMoveCard(cardId, toChapterId)
 *   mock.remoteRenameChapter(chapterId, name)
 *   await mock.stop()
 */
import http from 'node:http';

const CREATOR = 'u-mock-user';
const ISO = () => new Date().toISOString();
const pad = (n) => String(n).padStart(3, '0');
let deckSeq = 0;
let chapterSeq = 0;
let cardSeq = 0;
let fileSeq = 0;

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}
function ok(res, data) {
  json(res, 200, { errors: [], data, success: true });
}
function fail(res, status, code, msg, info = '') {
  json(res, status, { errors: [{ code, msg, info }], success: false });
}

function deckView(state, deck) {
  const chapters = state.chapters.filter((c) => c.deck_id === deck.id);
  return {
    id: deck.id,
    source: deck.source,
    status: deck.status,
    name: deck.name,
    description: deck.description,
    creator: CREATOR,
    authors: [CREATOR],
    revision: deck.revision,
    is_private: deck.is_private,
    card_count: state.cards.filter((c) => c.deck_id === deck.id).length,
    chapter_count: chapters.length,
    created_time: deck.created_time,
    updated_time: deck.updated_time,
  };
}
function chapterView(state, chapter) {
  return {
    id: chapter.id,
    deck_id: chapter.deck_id,
    name: chapter.name,
    revision: chapter.revision,
    card_ids: chapter.card_ids.slice(),
    creator: CREATOR,
    created_time: chapter.created_time,
    updated_time: chapter.updated_time,
  };
}
function chaptersetView(state, deck) {
  const set = state.chaptersets.find((s) => s.deck_id === deck.id);
  return {
    id: set.id,
    deck_id: deck.id,
    revision: set.revision,
    chapter_ids: set.chapter_ids.slice(),
    created_time: set.created_time,
    updated_time: set.updated_time,
  };
}
function cardView(card) {
  return {
    id: card.id,
    status: card.status,
    deck_id: card.deck_id,
    root_id: card.root_id,
    revision: card.revision,
    content: card.content,
    content_type: card.content_type,
    files: [],
    creator: CREATOR,
    source: 'SELF',
    grammar_version: card.grammar_version,
    card_rids: [],
    created_time: card.created_time,
    updated_time: card.updated_time,
  };
}
function touchDeck(state, deckId) {
  const deck = state.decks.find((d) => d.id === deckId);
  if (deck) {
    deck.revision += 1;
    deck.updated_time = ISO();
  }
  return deck;
}

/** Read a JSON body (empty body -> {}). */
async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  return JSON.parse(text);
}

/** Minimal multipart/form-data parser: returns { fields, files: [{ field, filename, mime, data }] }. */
function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType || '');
  if (!match) throw new Error('missing multipart boundary');
  const boundary = '--' + (match[1] || match[2]).trim();
  const text = buffer.toString('latin1');
  const parts = text.split(boundary);
  const fields = {};
  const files = [];
  for (const part of parts) {
    if (part === '' || part === '--\r\n' || part === '--\r\n' || part.trim() === '--') continue;
    const headerEnd = part.indexOf('\r\n\r\n');
    if (headerEnd < 0) continue;
    const header = part.slice(2, headerEnd); // strip leading CRLF
    const rawBody = part.slice(headerEnd + 4);
    const body = rawBody.endsWith('\r\n') ? rawBody.slice(0, -2) : rawBody;
    const nameMatch = /name="([^"]*)"/i.exec(header);
    const fileMatch = /filename="([^"]*)"/i.exec(header);
    const mimeMatch = /content-type:\s*([^\r\n]+)/i.exec(header);
    const name = nameMatch ? nameMatch[1] : '';
    if (fileMatch) {
      files.push({ field: name, filename: fileMatch[1], mime: mimeMatch ? mimeMatch[1].trim() : 'application/octet-stream', data: Buffer.from(body, 'latin1') });
    } else {
      fields[name] = Buffer.from(body, 'latin1').toString('utf8');
    }
  }
  return { fields, files };
}

export async function startMockMarkji(options = {}) {
  const token = options.token ?? 'mock-token';
  const state = { decks: [], chapters: [], chaptersets: [], cards: [], files: [], folders: [] };
  const requests = [];

  function newDeck(name, opts = {}) {
    deckSeq += 1;
    const id = 'mkjd_mock' + pad(deckSeq);
    const now = ISO();
    const deck = {
      id,
      source: 'SELF',
      status: 'NORMAL',
      name,
      description: opts.description ?? '',
      revision: 1,
      is_private: true,
      created_time: now,
      updated_time: now,
    };
    state.decks.push(deck);
    newChapterset(deck);
    if (opts.chapters) for (const chapterName of opts.chapters) newChapter(deck.id, chapterName);
    return deck;
  }
  function newChapterset(deck) {
    const now = ISO();
    const set = {
      id: 'mkjcs_mock' + pad(state.chaptersets.length + 1),
      deck_id: deck.id,
      revision: 1,
      chapter_ids: [],
      created_time: now,
      updated_time: now,
    };
    state.chaptersets.push(set);
    return set;
  }
  function newChapter(deckId, name, order) {
    chapterSeq += 1;
    const now = ISO();
    const chapter = {
      id: 'mkjch_mock' + pad(chapterSeq),
      deck_id: deckId,
      name,
      revision: 1,
      card_ids: [],
      created_time: now,
      updated_time: now,
    };
    state.chapters.push(chapter);
    const set = state.chaptersets.find((s) => s.deck_id === deckId);
    const index = Number.isInteger(order) ? Math.max(0, Math.min(order, set.chapter_ids.length)) : set.chapter_ids.length;
    set.chapter_ids.splice(index, 0, chapter.id);
    set.revision += 1;
    set.updated_time = now;
    touchDeck(state, deckId);
    return chapter;
  }
  function newCard(deckId, chapterId, content, grammarVersion = 3, order) {
    cardSeq += 1;
    const now = ISO();
    const card = {
      id: 'mkjc_mock' + pad(cardSeq),
      status: 'NORMAL',
      deck_id: deckId,
      root_id: 'mkjr_mock' + pad(cardSeq),
      revision: 1,
      content,
      content_type: 1,
      grammar_version: grammarVersion,
      created_time: now,
      updated_time: now,
    };
    state.cards.push(card);
    const chapter = state.chapters.find((c) => c.id === chapterId);
    const index = Number.isInteger(order) ? Math.max(0, Math.min(order, chapter.card_ids.length)) : chapter.card_ids.length;
    chapter.card_ids.splice(index, 0, card.id);
    chapter.revision += 1;
    chapter.updated_time = now;
    touchDeck(state, deckId);
    return card;
  }
  function findDeck(id) { return state.decks.find((d) => d.id === id); }
  function findChapter(id) { return state.chapters.find((c) => c.id === id); }
  function findCard(id) { return state.cards.find((c) => c.id === id); }

  /** Simulate an edit made in the Markji app (bumps revisions and timestamps). */
  function remoteEditCard(cardId, content) {
    const card = findCard(cardId);
    if (!card) throw new Error('mock: unknown card ' + cardId);
    card.content = content;
    card.revision += 1;
    card.updated_time = ISO();
    const chapter = state.chapters.find((c) => c.card_ids.includes(card.id));
    if (chapter) { chapter.updated_time = ISO(); }
    touchDeck(state, card.deck_id);
    return card;
  }
  /** Simulate a card deletion made in the Markji app (the plugin must only observe it). */
  function remoteDeleteCard(cardId) {
    const card = findCard(cardId);
    if (!card) throw new Error('mock: unknown card ' + cardId);
    state.cards = state.cards.filter((c) => c.id !== cardId);
    for (const chapter of state.chapters) chapter.card_ids = chapter.card_ids.filter((id) => id !== cardId);
    touchDeck(state, card.deck_id);
  }
  /** Simulate a chapter (and its cards) removed in the Markji app. */
  function remoteDeleteChapter(chapterId) {
    const chapter = findChapter(chapterId);
    if (!chapter) throw new Error('mock: unknown chapter ' + chapterId);
    const set = state.chaptersets.find((s) => s.deck_id === chapter.deck_id);
    if (set) {
      set.chapter_ids = set.chapter_ids.filter((id) => id !== chapterId);
      set.revision += 1;
      set.updated_time = ISO();
    }
    state.cards = state.cards.filter((card) => !chapter.card_ids.includes(card.id));
    state.chapters = state.chapters.filter((c) => c.id !== chapterId);
    touchDeck(state, chapter.deck_id);
  }
  /** Simulate a move made in the Markji app. */
  function remoteMoveCard(cardId, toChapterId) {
    const card = findCard(cardId);
    const to = findChapter(toChapterId);
    if (!card) throw new Error('mock: unknown card ' + cardId);
    if (!to) throw new Error('mock: unknown chapter ' + toChapterId);
    for (const chapter of state.chapters) chapter.card_ids = chapter.card_ids.filter((id) => id !== cardId);
    to.card_ids.push(cardId);
    to.revision += 1;
    to.updated_time = ISO();
    touchDeck(state, card.deck_id);
    return card;
  }
  function remoteRenameChapter(chapterId, name) {
    const chapter = findChapter(chapterId);
    if (!chapter) throw new Error('mock: unknown chapter ' + chapterId);
    chapter.name = name;
    chapter.revision += 1;
    chapter.updated_time = ISO();
    touchDeck(state, chapter.deck_id);
  }
  function remoteDeleteDeck(deckId) {
    state.decks = state.decks.filter((d) => d.id !== deckId);
    state.chaptersets = state.chaptersets.filter((s) => s.deck_id !== deckId);
    const chapterIds = state.chapters.filter((c) => c.deck_id === deckId).map((c) => c.id);
    state.chapters = state.chapters.filter((c) => c.deck_id !== deckId);
    state.cards = state.cards.filter((c) => !chapterIds.includes(c.deck_id) && c.deck_id !== deckId);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    let body = null;
    if (req.method === 'POST') {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      if ((req.headers['content-type'] || '').includes('multipart/form-data')) {
        body = { multipart: parseMultipart(raw, req.headers['content-type']) };
      } else if (raw.length > 0) {
        try { body = JSON.parse(raw.toString('utf8')); } catch { body = raw.toString('utf8'); }
      }
    }
    requests.push({ method: req.method, path, query: Object.fromEntries(url.searchParams), body });

    if (req.headers.authorization !== 'Bearer ' + token) {
      return fail(res, 401, 'common_unauthorized', 'Authorization failed');
    }
    try {
      const segments = path.replace(/^\/+|\/+$/g, '').split('/');
      // Expected: api/v1/markji/...
      if (segments[0] !== 'api' || segments[1] !== 'v1' || segments[2] !== 'markji') {
        return fail(res, 404, 'common_not_found', 'No route');
      }
      const rest = segments.slice(3);
      if (req.method === 'GET' && rest.join('/') === 'decks/folders') {
        return ok(res, { folders: state.folders });
      }
      if (req.method === 'GET' && rest.length === 1 && rest[0] === 'decks') {
        const offset = Number(url.searchParams.get('offset') ?? 0);
        const limit = Number(url.searchParams.get('limit') ?? 100);
        const folderId = url.searchParams.get('folder_id');
        let decks = state.decks;
        if (folderId) {
          const folder = state.folders.find((f) => f.id === folderId);
          const itemIds = folder ? folder.items.map((item) => item.object_id) : [];
          decks = decks.filter((d) => itemIds.includes(d.id));
        }
        const page = decks.slice(offset, offset + limit).map((d) => deckView(state, d));
        return ok(res, { decks: page, total: decks.length });
      }
      if (req.method === 'GET' && rest.length === 2 && rest[0] === 'decks') {
        const deck = findDeck(rest[1]);
        if (!deck) return fail(res, 400, 'common_invalid_res_id', 'Invalid resource id', 'id: ' + rest[1]);
        return ok(res, { deck: deckView(state, deck) });
      }
      if (rest[0] === 'decks' && rest[2] === 'chapters') {
        const deck = findDeck(rest[1]);
        if (!deck) return fail(res, 400, 'common_invalid_res_id', 'Invalid resource id', 'id: ' + rest[1]);
        const sub = rest.slice(3);
        if (req.method === 'GET' && sub.length === 0) {
          const chapters = state.chapters.filter((c) => c.deck_id === deck.id);
          const data = { chapterset: chaptersetView(state, deck), chapters: chapters.map((c) => chapterView(state, c)) };
          if (url.searchParams.get('with_cards') === 'true') {
            const ids = chapters.flatMap((c) => c.card_ids);
            data.cards = ids.map((id) => findCard(id)).filter(Boolean).map(cardView);
          }
          return ok(res, data);
        }
        if (req.method === 'POST' && sub.length === 0) {
          if (!body || typeof body.name !== 'string' || body.name === '') {
            return fail(res, 400, 'common_invalid_param', 'Invalid name');
          }
          const chapter = newChapter(deck.id, body.name, body.order);
          return ok(res, { chapter: chapterView(state, chapter), chapterset: chaptersetView(state, deck) });
        }
        if (req.method === 'POST' && sub.length === 1 && sub[0] === 'sort') {
          const set = state.chaptersets.find((s) => s.deck_id === deck.id);
          if (Number(body.revision) !== set.revision) {
            return fail(res, 409, 'common_revision_mismatch', 'Revision mismatch', 'revision: ' + body.revision);
          }
          const ids = Array.isArray(body.chapter_ids) ? body.chapter_ids : [];
          const known = new Set(state.chapters.filter((c) => c.deck_id === deck.id).map((c) => c.id));
          if (ids.length !== known.size || ids.some((id) => !known.has(id))) {
            return fail(res, 400, 'common_invalid_param', 'chapter_ids must list every chapter exactly once');
          }
          set.chapter_ids = ids.slice();
          set.revision += 1;
          set.updated_time = ISO();
          touchDeck(state, deck.id);
          return ok(res, { chapterset: chaptersetView(state, deck) });
        }
        if (req.method === 'GET' && sub.length === 1) {
          const chapter = findChapter(sub[0]);
          if (!chapter || chapter.deck_id !== deck.id) return fail(res, 400, 'common_invalid_res_id', 'Invalid resource id');
          const data = { chapter: chapterView(state, chapter), chapterset: chaptersetView(state, deck) };
          if (url.searchParams.get('with_cards') === 'true') {
            data.cards = chapter.card_ids.map((id) => findCard(id)).filter(Boolean).map(cardView);
          }
          return ok(res, data);
        }
        if (req.method === 'POST' && sub.length === 1) {
          const chapter = findChapter(sub[0]);
          if (!chapter || chapter.deck_id !== deck.id) return fail(res, 400, 'common_invalid_res_id', 'Invalid resource id');
          if (body.revision !== undefined && body.revision !== null && Number(body.revision) !== chapter.revision) {
            return fail(res, 409, 'common_revision_mismatch', 'Revision mismatch', 'revision: ' + body.revision);
          }
          if (typeof body.name !== 'string' || body.name === '') return fail(res, 400, 'common_invalid_param', 'Invalid name');
          chapter.name = body.name;
          chapter.revision += 1;
          chapter.updated_time = ISO();
          touchDeck(state, deck.id);
          return ok(res, { chapter: chapterView(state, chapter) });
        }
        if (req.method === 'POST' && sub.length >= 2 && sub[1] === 'cards') {
          const chapter = findChapter(sub[0]);
          if (!chapter || chapter.deck_id !== deck.id) return fail(res, 400, 'common_invalid_res_id', 'Invalid resource id');
          if (sub.length === 2) {
            if (!body.card || typeof body.card.content !== 'string') return fail(res, 400, 'common_invalid_param', 'Invalid card');
            const card = newCard(deck.id, chapter.id, body.card.content, Number.isInteger(body.card.grammar_version) ? body.card.grammar_version : 3, body.order);
            return ok(res, { card: cardView(card), chapter: chapterView(state, chapter) });
          }
          if (sub[2] === 'move') {
            const ids = Array.isArray(body.card_ids) ? body.card_ids : [];
            const to = findChapter(body.to_chapter_id);
            if (!to || to.deck_id !== deck.id) return fail(res, 400, 'common_invalid_res_id', 'Invalid target chapter');
            if (ids.some((id) => !chapter.card_ids.includes(id))) {
              return fail(res, 400, 'common_invalid_param', 'card not in source chapter');
            }
            chapter.card_ids = chapter.card_ids.filter((id) => !ids.includes(id));
            const index = Number.isInteger(body.order) ? Math.max(0, Math.min(body.order, to.card_ids.length)) : to.card_ids.length;
            to.card_ids.splice(index, 0, ...ids);
            chapter.revision += 1;
            to.revision += 1;
            chapter.updated_time = ISO();
            to.updated_time = ISO();
            touchDeck(state, deck.id);
            return ok(res, { new_chapter: chapterView(state, to), old_chapter: chapterView(state, chapter) });
          }
          return fail(res, 404, 'common_not_found', 'No route');
        }
        return fail(res, 404, 'common_not_found', 'No route');
      }
      if (rest[0] === 'decks' && rest[2] === 'cards' && req.method === 'GET' && rest.length === 4) {
        const deck = findDeck(rest[1]);
        const card = findCard(rest[3]);
        if (!deck || !card || card.deck_id !== deck.id) return fail(res, 400, 'common_invalid_res_id', 'Invalid resource id');
        return ok(res, { card: cardView(card) });
      }
      if (rest[0] === 'decks' && rest[2] === 'cards' && req.method === 'POST' && rest.length === 4) {
        const deck = findDeck(rest[1]);
        const card = findCard(rest[3]);
        if (!deck || !card || card.deck_id !== deck.id) return fail(res, 400, 'common_invalid_res_id', 'Invalid resource id');
        if (!body.card || typeof body.card.content !== 'string') return fail(res, 400, 'common_invalid_param', 'Invalid card');
        card.content = body.card.content;
        if (Number.isInteger(body.card.grammar_version)) card.grammar_version = body.card.grammar_version;
        card.revision += 1;
        card.updated_time = ISO();
        const chapter = state.chapters.find((c) => c.card_ids.includes(card.id));
        if (chapter) chapter.updated_time = ISO();
        touchDeck(state, deck.id);
        return ok(res, { card: cardView(card) });
      }
      if (rest[0] === 'files' && req.method === 'POST' && rest.length === 1) {
        const multipart = body && body.multipart;
        const uploaded = multipart && multipart.files.find((f) => f.field === 'file');
        if (!uploaded) return fail(res, 400, 'common_invalid_param', 'Missing file field');
        fileSeq += 1;
        const id = 'mkjf_mock' + pad(fileSeq);
        const file = {
          id,
          url: baseUrl + '/files/' + id,
          mime: uploaded.mime,
          size: Math.max(4, Math.ceil(uploaded.data.length / 4096) * 4),
          info: { filename: uploaded.filename, deck_id: multipart.fields.deck_id ?? '' },
          expire_time: new Date(Date.now() + 30 * 86400000).toISOString(),
        };
        state.files.push({ file, data: uploaded.data });
        return ok(res, { file });
      }
      if (rest[0] === 'files' && rest[1] === 'query' && req.method === 'POST' && rest.length === 2) {
        const ids = Array.isArray(body.ids) ? body.ids : [];
        const files = ids.map((id) => state.files.find((entry) => entry.file.id === id)).filter(Boolean).map((entry) => entry.file);
        return ok(res, { files });
      }
      return fail(res, 404, 'common_not_found', 'No route');
    } catch (error) {
      return fail(res, 500, 'common_internal', error && error.message ? error.message : String(error));
    }
  });

  await new Promise((resolve) => server.listen(options.port ?? 0, '127.0.0.1', resolve));
  const address = server.address();
  const baseUrl = 'http://127.0.0.1:' + address.port;

  return {
    url: baseUrl,
    token,
    state,
    requests,
    newDeck,
    newChapter,
    newCard,
    findDeck,
    findChapter,
    findCard,
    remoteEditCard,
    remoteDeleteCard,
    remoteRenameChapter,
    remoteDeleteChapter,
    remoteMoveCard,
    remoteDeleteDeck,
    async stop() {
      // Destroy keep-alive sockets so node:test does not wait for idle timeouts.
      if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
