// dsh-markji-bridge: Markji HTTP client unit tests.
// fetchImpl / limiter / sleep / random / clock are injected: no network, no real sleeps.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, MarkjiError } from "../lib/api.js";

const BASE = "https://open.maimemo.com/open";

function envelope(data) {
  return { success: true, errors: [], data };
}

function jsonResponse(data, { status = 200, headers = {} } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function makeClient(responder, options = {}) {
  const limiterCalls = { acquire: 0 };
  const limiter = {
    acquire: async () => {
      limiterCalls.acquire += 1;
    },
    snapshot: () => ({ used: [], limits: [], waitMs: 0 }),
    reset: () => {},
  };
  const fetches = [];
  const sleepCalls = [];
  const logs = [];
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init });
    return responder({ url, init, attempt: fetches.length });
  };
  const client = createClient({
    apiKey: options.apiKey !== undefined ? options.apiKey : "test-token",
    baseUrl: BASE,
    timeoutMs: options.timeoutMs ?? 1000,
    maxRetries: options.maxRetries ?? 0,
    limiter,
    fetchImpl,
    log: (level, message) => logs.push({ level, message }),
    sleep: async (ms) => {
      sleepCalls.push(ms);
    },
    random: () => 0,
    now: options.now ?? (() => 1000),
  });
  return { client, fetches, sleepCalls, limiterCalls, logs };
}

test("listFolders unwraps the envelope and sends auth headers", async () => {
  const folders = [{ id: "f1", name: "Folder", items: [{ object_id: "d1", object_class: "deck" }] }];
  const { client, fetches, limiterCalls } = makeClient(() => jsonResponse(envelope({ folders })));

  const result = await client.listFolders();
  assert.deepEqual(result, folders);

  assert.equal(fetches.length, 1);
  const { url, init } = fetches[0];
  assert.equal(url, BASE + "/api/v1/markji/decks/folders");
  assert.equal(init.method, "GET");
  assert.equal(init.headers.authorization, "Bearer test-token");
  assert.equal(init.headers.accept, "application/json");
  assert.equal(init.headers["content-type"], undefined);
  assert.equal(init.body, undefined);
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(limiterCalls.acquire, 1);
});

test("provider error envelope with HTTP 200 throws a MarkjiError", async () => {
  const errors = [{ code: "common_invalid_res_id", msg: "Invalid resource id", info: "id: bad" }];
  const { client, fetches } = makeClient(() => jsonResponse({ success: false, errors }));

  await assert.rejects(client.getCard("d1", "bad"), (err) => {
    assert.ok(err instanceof MarkjiError);
    assert.equal(err.code, "common_invalid_res_id");
    assert.equal(err.message, "Invalid resource id");
    assert.equal(err.status, 200);
    assert.equal(err.retriable, false);
    assert.deepEqual(err.details, errors);
    return true;
  });
  assert.equal(fetches.length, 1);
});

test("401 is not retried and keeps the provider code", async () => {
  const { client, fetches, sleepCalls } = makeClient(
    () => jsonResponse({ success: false, errors: [{ code: "common_unauthorized", msg: "Unauthorized" }] }, { status: 401 }),
    { maxRetries: 3 },
  );
  await assert.rejects(client.listFolders(), (err) => {
    assert.equal(err.code, "common_unauthorized");
    assert.equal(err.status, 401);
    assert.equal(err.retriable, false);
    return true;
  });
  assert.equal(fetches.length, 1);
  assert.deepEqual(sleepCalls, []);
});

test("400 invalid id is not retried", async () => {
  const { client, fetches } = makeClient(
    () => jsonResponse({ success: false, errors: [{ code: "common_invalid_res_id", msg: "Invalid resource id" }] }, { status: 400 }),
    { maxRetries: 3 },
  );
  await assert.rejects(client.getCard("d1", "bad"), (err) => {
    assert.equal(err.code, "common_invalid_res_id");
    assert.equal(err.status, 400);
    return true;
  });
  assert.equal(fetches.length, 1);
});

test("429 retries honoring Retry-After then succeeds", async () => {
  const { client, fetches, sleepCalls } = makeClient(
    ({ attempt }) => {
      if (attempt === 1) {
        return jsonResponse({ success: false, errors: [] }, { status: 429, headers: { "retry-after": "2" } });
      }
      return jsonResponse(envelope({ folders: [] }));
    },
    { maxRetries: 2 },
  );

  assert.deepEqual(await client.listFolders(), []);
  assert.equal(fetches.length, 2);
  assert.deepEqual(sleepCalls, [2000]);
  const stats = client.stats();
  assert.equal(stats.requests, 2);
  assert.equal(stats.retries, 1);
  assert.equal(stats.lastStatus, 200);
});

test("500 retries with exponential backoff up to maxRetries then throws", async () => {
  const { client, fetches, sleepCalls } = makeClient(
    () => jsonResponse({ success: false, errors: [{ code: "server_error", msg: "boom" }] }, { status: 500 }),
    { maxRetries: 2 },
  );

  await assert.rejects(client.listFolders(), (err) => {
    assert.equal(err.code, "server_error");
    assert.equal(err.status, 500);
    assert.equal(err.retriable, true);
    assert.equal(err.message, "boom");
    return true;
  });
  assert.equal(fetches.length, 3);
  assert.deepEqual(sleepCalls, [500, 1000]);
  const stats = client.stats();
  assert.equal(stats.requests, 3);
  assert.equal(stats.retries, 2);
  assert.equal(stats.lastStatus, 500);
  assert.equal(stats.lastErrorAt, 1000);
});

test("408 is treated as retriable", async () => {
  const { client, fetches, sleepCalls } = makeClient(
    ({ attempt }) => (attempt === 1 ? new Response("timeout", { status: 408 }) : jsonResponse(envelope({ folders: [] }))),
    { maxRetries: 1 },
  );
  await client.listFolders();
  assert.equal(fetches.length, 2);
  assert.deepEqual(sleepCalls, [500]);
});

test("network errors are retried and surface as retriable network_error", async () => {
  const { client, fetches, sleepCalls } = makeClient(
    () => {
      throw new TypeError("fetch failed");
    },
    { maxRetries: 1 },
  );
  await assert.rejects(client.listFolders(), (err) => {
    assert.equal(err.code, "network_error");
    assert.equal(err.retriable, true);
    assert.equal(err.status, null);
    return true;
  });
  assert.equal(fetches.length, 2);
  assert.deepEqual(sleepCalls, [500]);
});

test("timeouts map to timeout and are retried", async () => {
  const { client, fetches } = makeClient(
    () => {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    },
    { maxRetries: 1 },
  );
  await assert.rejects(client.listFolders(), (err) => {
    assert.equal(err.code, "timeout");
    assert.equal(err.retriable, true);
    return true;
  });
  assert.equal(fetches.length, 2);
});

test("non-JSON success body is a non-retriable bad_response with a snippet", async () => {
  const { client, fetches } = makeClient(() => new Response("<html>upstream nope</html>", { status: 200 }));
  await assert.rejects(client.listFolders(), (err) => {
    assert.equal(err.code, "bad_response");
    assert.equal(err.retriable, false);
    assert.match(err.details.body, /upstream nope/);
    return true;
  });
  assert.equal(fetches.length, 1);
});

test("success body without data is bad_response", async () => {
  const { client } = makeClient(() => jsonResponse({ success: true, errors: [] }));
  await assert.rejects(client.listFolders(), (err) => {
    assert.equal(err.code, "bad_response");
    return true;
  });
});

test("not_configured: client reports configured false and every method rejects", async () => {
  const { client, fetches } = makeClient(() => jsonResponse(envelope({})), { apiKey: "" });
  assert.equal(client.configured, false);

  const calls = {
    listFolders: () => client.listFolders(),
    listDecksPage: () => client.listDecksPage({}),
    listAllDecks: () => client.listAllDecks({}),
    getDeck: () => client.getDeck("d1"),
    listChapters: () => client.listChapters("d1"),
    getChapter: () => client.getChapter("d1", "c1"),
    createChapter: () => client.createChapter({ deck: "d1", name: "n" }),
    updateChapter: () => client.updateChapter({ deck: "d1", chapter: "c1", name: "n" }),
    sortChapters: () => client.sortChapters({ deck: "d1", chapter_ids: [], revision: 1 }),
    getCard: () => client.getCard("d1", "c1"),
    createCard: () => client.createCard({ deck: "d1", chapter: "c1", card: { content: "x", grammar_version: 3 } }),
    updateCard: () => client.updateCard({ deck_id: "d1", card_id: "c1", card: { content: "x", grammar_version: 3 } }),
    moveCards: () => client.moveCards({ deck: "d1", chapter: "c1", card_ids: ["a"], to_chapter_id: "c2" }),
    uploadFile: () => client.uploadFile({ data: new Uint8Array([1]), filename: "a.png" }),
    queryFiles: () => client.queryFiles({ ids: [] }),
    // stats() is synchronous; wrap it so assert.rejects can observe the throw.
    stats: async () => client.stats(),
  };
  for (const [name, call] of Object.entries(calls)) {
    await assert.rejects(call(), (err) => {
      assert.ok(err instanceof MarkjiError, name);
      assert.equal(err.code, "not_configured", name);
      return true;
    });
  }
  assert.equal(fetches.length, 0);
});

test("configured is true for a token", () => {
  const { client } = makeClient(() => jsonResponse(envelope({})));
  assert.equal(client.configured, true);
});

test("path segments are URL encoded", async () => {
  const card = { id: "c#2" };
  const { client, fetches } = makeClient(() => jsonResponse(envelope({ card })));
  const result = await client.getCard("d/1 ?", "c#2");
  assert.deepEqual(result, card);
  assert.equal(fetches[0].url, BASE + "/api/v1/markji/decks/d%2F1%20%3F/cards/c%232");
});

test("read endpoints use the documented query and response shapes", async () => {
  const page = { decks: [{ id: "d1" }], total: 1 };
  const first = makeClient(() => jsonResponse(envelope(page)));
  assert.deepEqual(await first.client.listDecksPage({ offset: 5, limit: 10, folder_id: "f1" }), {
    decks: [{ id: "d1" }],
    total: 1,
  });
  const url = new URL(first.fetches[0].url);
  assert.equal(url.pathname, "/open/api/v1/markji/decks");
  assert.equal(url.searchParams.get("offset"), "5");
  assert.equal(url.searchParams.get("limit"), "10");
  assert.equal(url.searchParams.get("folder_id"), "f1");

  const emptyPage = makeClient(() => jsonResponse(envelope({ decks: [{ id: "d1" }] })));
  assert.deepEqual(await emptyPage.client.listDecksPage({}), { decks: [{ id: "d1" }], total: 1 });
  assert.equal(emptyPage.fetches[0].url, BASE + "/api/v1/markji/decks");

  const deck = { id: "d1", name: "Deck" };
  const deckClient = makeClient(() => jsonResponse(envelope({ deck })));
  assert.deepEqual(await deckClient.client.getDeck("d1", { with_root: true }), deck);
  assert.equal(deckClient.fetches[0].url, BASE + "/api/v1/markji/decks/d1?with_root=true");

  const chapters = { chapterset: { revision: 2 }, chapters: [{ id: "c1" }], cards: [{ id: "cd1" }] };
  const chaptersClient = makeClient(() => jsonResponse(envelope(chapters)));
  const listed = await chaptersClient.client.listChapters("d1", { with_cards: true, updated_time: "2026-01-01T00:00:00Z" });
  assert.deepEqual(listed, chapters);
  const chaptersUrl = new URL(chaptersClient.fetches[0].url);
  assert.equal(chaptersUrl.searchParams.get("with_cards"), "true");
  assert.equal(chaptersUrl.searchParams.get("updated_time"), "2026-01-01T00:00:00Z");

  const sparse = makeClient(() => jsonResponse(envelope({ chapterset: { revision: 1 } })));
  assert.deepEqual(await sparse.client.listChapters("d1"), {
    chapterset: { revision: 1 },
    chapters: [],
    cards: [],
  });

  const chapter = { id: "c1", name: "Chapter" };
  const chapterClient = makeClient(() => jsonResponse(envelope({ chapter, cards: [{ id: "cd1" }] })));
  const got = await chapterClient.client.getChapter("d1", "c1", { with_cards: true });
  assert.deepEqual(got, { chapterset: undefined, chapter, cards: [{ id: "cd1" }] });
  assert.equal(chapterClient.fetches[0].url, BASE + "/api/v1/markji/decks/d1/chapters/c1?with_cards=true");
});

test("write endpoints send the documented method and path, without repeating path ids in the body", async () => {
  const cases = [
    {
      name: "createChapter",
      run: (client) => client.createChapter({ deck: "d1", name: "New", order: 2 }),
      data: { chapter: { id: "ch1" }, chapterset: { id: "cs1" } },
      method: "POST",
      path: "/api/v1/markji/decks/d1/chapters",
      body: { name: "New", order: 2 },
      expected: { chapter: { id: "ch1" }, chapterset: { id: "cs1" } },
    },
    {
      name: "createChapter without order",
      run: (client) => client.createChapter({ deck: "d1", name: "New" }),
      data: { chapter: { id: "ch1" }, chapterset: { id: "cs1" } },
      method: "POST",
      path: "/api/v1/markji/decks/d1/chapters",
      body: { name: "New" },
      expected: { chapter: { id: "ch1" }, chapterset: { id: "cs1" } },
    },
    {
      name: "updateChapter",
      run: (client) => client.updateChapter({ deck: "d1", chapter: "c1", name: "Renamed", revision: 4 }),
      data: { chapter: { id: "c1", name: "Renamed", revision: 5 } },
      method: "POST",
      path: "/api/v1/markji/decks/d1/chapters/c1",
      body: { name: "Renamed", revision: 4 },
      expected: { id: "c1", name: "Renamed", revision: 5 },
    },
    {
      name: "sortChapters",
      run: (client) => client.sortChapters({ deck: "d1", chapter_ids: ["b", "a"], revision: 7 }),
      data: { chapterset: { revision: 8, chapter_ids: ["b", "a"] } },
      method: "POST",
      path: "/api/v1/markji/decks/d1/chapters/sort",
      body: { chapter_ids: ["b", "a"], revision: 7 },
      expected: { revision: 8, chapter_ids: ["b", "a"] },
    },
    {
      name: "createCard",
      run: (client) =>
        client.createCard({ deck: "d1", chapter: "c1", card: { content: "hello", grammar_version: 3 }, order: 1 }),
      data: { card: { id: "cd1", content: "hello" }, chapter: { id: "c1", revision: 2 } },
      method: "POST",
      path: "/api/v1/markji/decks/d1/chapters/c1/cards",
      body: { card: { content: "hello", grammar_version: 3 }, order: 1 },
      expected: { card: { id: "cd1", content: "hello" }, chapter: { id: "c1", revision: 2 } },
    },
    {
      name: "updateCard",
      run: (client) =>
        client.updateCard({ deck_id: "d1", card_id: "cd1", card: { content: "new", grammar_version: 3 } }),
      data: { card: { id: "cd1", content: "new", revision: 6 } },
      method: "POST",
      path: "/api/v1/markji/decks/d1/cards/cd1",
      body: { card: { content: "new", grammar_version: 3 } },
      expected: { id: "cd1", content: "new", revision: 6 },
    },
    {
      name: "moveCards",
      run: (client) =>
        client.moveCards({ deck: "d1", chapter: "c1", card_ids: ["cd1", "cd2"], to_chapter_id: "c2", order: 0 }),
      data: { new_chapter: { id: "c2" }, old_chapter: { id: "c1" } },
      method: "POST",
      path: "/api/v1/markji/decks/d1/chapters/c1/cards/move",
      body: { card_ids: ["cd1", "cd2"], to_chapter_id: "c2", order: 0 },
      expected: { new_chapter: { id: "c2" }, old_chapter: { id: "c1" } },
    },
  ];

  for (const entry of cases) {
    const { client, fetches } = makeClient(() => jsonResponse(envelope(entry.data)));
    const result = await entry.run(client);
    assert.equal(fetches.length, 1, entry.name);
    const { url, init } = fetches[0];
    assert.equal(init.method, entry.method, entry.name);
    assert.equal(url, BASE + entry.path, entry.name);
    assert.equal(init.headers["content-type"], "application/json", entry.name);
    assert.deepEqual(JSON.parse(init.body), entry.body, entry.name);
    assert.deepEqual(result, entry.expected, entry.name);
  }
});

test("write endpoints retry with the path ids in the body when the provider requires them", async () => {
  const requiredError = {
    success: false,
    errors: [{ code: "common_invalid_param", msg: "Invalid parameters", info: "{base} must have required property 'deck'" }],
    data: {},
  };
  const { client, fetches } = makeClient(({ attempt }) =>
    attempt === 1
      ? jsonResponse(requiredError, { status: 400 })
      : jsonResponse(envelope({ card: { id: "cd1" }, chapter: { id: "c1" } })),
  );
  const result = await client.createCard({
    deck: "mkjd_d1",
    chapter: "mkjch_c1",
    card: { content: "hello", grammar_version: 3 },
  });
  assert.equal(fetches.length, 2);
  assert.deepEqual(JSON.parse(fetches[0].init.body), { card: { content: "hello", grammar_version: 3 } });
  assert.deepEqual(JSON.parse(fetches[1].init.body), {
    deck: "mkjd_d1",
    chapter: "mkjch_c1",
    card: { content: "hello", grammar_version: 3 },
  });
  assert.deepEqual(result, { card: { id: "cd1" }, chapter: { id: "c1" } });
});

test("listAllDecks follows total across pages", async () => {
  const pages = [
    { decks: [{ id: "d1" }, { id: "d2" }], total: 5 },
    { decks: [{ id: "d3" }, { id: "d4" }], total: 5 },
    { decks: [{ id: "d5" }], total: 5 },
  ];
  const { client, fetches } = makeClient(() => jsonResponse(envelope(pages[fetches.length - 1])));
  const decks = await client.listAllDecks({ pageSize: 2 });
  assert.deepEqual(
    decks.map((deck) => deck.id),
    ["d1", "d2", "d3", "d4", "d5"],
  );
  assert.equal(fetches.length, 3);
  assert.deepEqual(
    fetches.map((fetch) => new URL(fetch.url).searchParams.get("offset")),
    ["0", "2", "4"],
  );
  assert.deepEqual(
    fetches.map((fetch) => new URL(fetch.url).searchParams.get("limit")),
    ["2", "2", "2"],
  );
});

test("listAllDecks defaults to a page size of 100 and stops when total is reached", async () => {
  const firstPage = Array.from({ length: 100 }, (_, index) => ({ id: `d${index}` }));
  const { client, fetches } = makeClient(({ attempt }) =>
    attempt === 1
      ? jsonResponse(envelope({ decks: firstPage, total: 101 }))
      : jsonResponse(envelope({ decks: [{ id: "d100" }], total: 101 })),
  );
  const decks = await client.listAllDecks({});
  assert.equal(decks.length, 101);
  assert.equal(fetches.length, 2);
  assert.equal(new URL(fetches[0].url).searchParams.get("limit"), "100");
  assert.equal(new URL(fetches[0].url).searchParams.get("offset"), "0");
  assert.equal(new URL(fetches[1].url).searchParams.get("offset"), "100");
});

test("listAllDecks stops at the hard 100 page guard", async () => {
  const { client, fetches } = makeClient(() => jsonResponse(envelope({ decks: [{ id: "d1" }], total: 1000 })));
  const decks = await client.listAllDecks({ pageSize: 1 });
  assert.equal(decks.length, 100);
  assert.equal(fetches.length, 100);
});

test("multipart upload sends the file field, inferred mime and deck_id", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "markji-api-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "picture.png");
  await writeFile(path, new Uint8Array([137, 80, 78, 71]));

  const file = { id: "f1", name: "picture.png" };
  const { client, fetches } = makeClient(() => jsonResponse(envelope({ file })));

  const result = await client.uploadFile({ path, deck_id: "d1" });
  assert.deepEqual(result, file);
  assert.equal(fetches.length, 1);
  const { url, init } = fetches[0];
  assert.equal(url, BASE + "/api/v1/markji/files");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["content-type"], undefined, "fetch owns the multipart content-type");
  assert.ok(init.body instanceof FormData);
  const uploaded = init.body.get("file");
  assert.ok(uploaded instanceof Blob);
  assert.equal(uploaded.name, "picture.png");
  assert.equal(uploaded.type, "image/png");
  assert.equal(init.body.get("deck_id"), "d1");
});

test("uploadFile accepts raw bytes and infers mime from the filename", async () => {
  const mimeCases = [
    ["a.jpg", "image/jpeg"],
    ["b.WEBP", "image/webp"],
    ["c.mp3", "audio/mpeg"],
    ["d.bin", "application/octet-stream"],
  ];
  for (const [filename, expectedType] of mimeCases) {
    const { client, fetches } = makeClient(() => jsonResponse(envelope({ file: { id: "f1" } })));
    await client.uploadFile({ data: new Uint8Array([1, 2, 3]), filename });
    const form = fetches[0].init.body;
    assert.ok(form instanceof FormData, filename);
    assert.equal(form.get("file").type, expectedType, filename);
    assert.equal(form.get("deck_id"), null, filename);
  }

  const { client } = makeClient(() => jsonResponse(envelope({ file: { id: "f1" } })));
  await client.uploadFile({ data: new Uint8Array([1]), filename: "x.bin", mime: "text/plain", deck_id: 42 });
});

test("uploadFile requires path or data", async () => {
  const { client, fetches } = makeClient(() => jsonResponse(envelope({})));
  await assert.rejects(client.uploadFile({}), (err) => {
    assert.ok(err instanceof MarkjiError);
    assert.equal(err.code, "invalid_argument");
    return true;
  });
  assert.equal(fetches.length, 0);
});

test("queryFiles posts ids and optional expires", async () => {
  const files = [{ id: "f1" }, { id: "f2" }];
  const { client, fetches } = makeClient(() => jsonResponse(envelope({ files })));
  assert.deepEqual(await client.queryFiles({ ids: ["f1", "f2"], expires: 12345 }), files);
  assert.equal(fetches[0].url, BASE + "/api/v1/markji/files/query");
  assert.equal(fetches[0].init.method, "POST");
  assert.deepEqual(JSON.parse(fetches[0].init.body), { ids: ["f1", "f2"], expires: 12345 });

  const without = makeClient(() => jsonResponse(envelope({ files: [] })));
  assert.deepEqual(await without.client.queryFiles({ ids: [] }), []);
  assert.deepEqual(JSON.parse(without.fetches[0].init.body), { ids: [] });
});

test("stats reports requests, retries, lastStatus and lastErrorAt", async () => {
  const ok = makeClient(() => jsonResponse(envelope({ folders: [] })));
  await ok.client.listFolders();
  assert.deepEqual(ok.client.stats(), { requests: 1, retries: 0, lastStatus: 200, lastErrorAt: null });

  const failing = makeClient(
    () => jsonResponse({ success: false, errors: [{ code: "server_error", msg: "boom" }] }, { status: 500 }),
    { maxRetries: 1, now: () => 4242 },
  );
  await assert.rejects(failing.client.listFolders());
  assert.deepEqual(failing.client.stats(), { requests: 2, retries: 1, lastStatus: 500, lastErrorAt: 4242 });
});

test("whitespace-only apiKey counts as not configured", async () => {
  const { client, fetches } = makeClient(() => jsonResponse(envelope({})), { apiKey: "   " });
  assert.equal(client.configured, false);
  await assert.rejects(client.listFolders(), (err) => err.code === "not_configured");
  assert.equal(fetches.length, 0);
});
