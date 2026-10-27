import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { apply, inject } from '../index.js';

const dir = await mkdtemp(join(tmpdir(), 'markji-idx-'));
const registered = new Map();
const effects = [];
const ctx = {
  tools: {
    register(def) {
      if (!def || typeof def.name !== 'string') throw new Error('bad tool def');
      registered.set(def.name, def);
      return () => registered.delete(def.name);
    },
  },
  effect(fn, label) {
    effects.push(label);
    return fn();
  },
};
const disposer = apply(ctx, { dataDir: dir, autoSync: false, pullTtlMs: 60000 });
if (typeof disposer !== 'function') throw new Error('apply did not return the effect disposer');
if (inject.join(',') !== 'tools') throw new Error('inject mismatch');
await new Promise((r) => setTimeout(r, 150));
const names = [...registered.keys()];
if (names.length !== 4) throw new Error('expected 4 tools, got ' + names.length + ': ' + names.join(','));
const expected = ['markji_decks', 'markji_cards', 'markji_sync', 'markji_file'];
for (const name of expected) if (!registered.has(name)) throw new Error('missing tool ' + name);
const syncDef = registered.get('markji_sync');
const status = await syncDef.execute({ action: 'state' });
if (!status || !status.cache || typeof status.cache.cards !== 'number') throw new Error('state output: ' + JSON.stringify(status));
if (status.version !== '2.7.0') throw new Error('status version: ' + status.version);
const progress = await syncDef.execute({ action: 'progress' });
if (!progress || !Array.isArray(progress.tasks)) throw new Error('progress output: ' + JSON.stringify(progress));
const failures = await syncDef.execute({ action: 'failures' });
if (!failures || !failures.summary) throw new Error('failures output: ' + JSON.stringify(failures));
const cardsDef = registered.get('markji_cards');
if (cardsDef.parameters.properties.action.enum.includes('validate')) throw new Error('markji_cards still exposes validate');
if (registered.has('markji_card_syntax')) throw new Error('legacy markji_card_syntax still registered');
const help = await cardsDef.execute({ action: 'syntax_help' });
if (!help || help.ok !== true || !Array.isArray(help.formats) || help.formats.length !== 9) {
  throw new Error('syntax help output: ' + JSON.stringify(help));
}
const pictureHelp = await cardsDef.execute({ action: 'syntax_help', format: 'picture' });
if (!pictureHelp || pictureHelp.ok !== true || pictureHelp.tag !== 'Pic') {
  throw new Error('syntax help format lookup: ' + JSON.stringify(pictureHelp));
}
if (!cardsDef.parameters.properties.cards || !cardsDef.parameters.properties.new_cards || !cardsDef.parameters.properties.updates) {
  throw new Error('markji_cards batch schema');
}
const createItem = cardsDef.parameters.properties.new_cards.items.properties;
if (!createItem.deck || !createItem.chapter) throw new Error('markji_cards item target schema');
const decksDef = registered.get('markji_decks');
if (!decksDef.parameters.properties.action.enum.includes('chapter_get')) throw new Error('markji_decks chapter actions');
if (!decksDef.parameters.properties.with_cards) throw new Error('markji_decks with_cards schema');
if (!syncDef.parameters.properties.action.enum.includes('resolve')) throw new Error('markji_sync resolve action');
if (!syncDef.parameters.properties.ids || !syncDef.parameters.properties.items) throw new Error('markji_sync resolve batch schema');
if (!status.cache || typeof status.cache.bytes !== 'number') throw new Error('status cache: ' + JSON.stringify(status.cache));
const handle = new DatabaseSync(join(dir, 'cache.db'), { readOnly: true });
try {
  const version = handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!version || Number(version.value) !== 4) throw new Error('cache.db schema_version: ' + JSON.stringify(version));
  const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['meta', 'folders', 'decks', 'chapters', 'cards', 'conflicts', 'moves', 'tasks', 'secrets']) {
    if (!tables.includes(table)) throw new Error('cache.db missing table ' + table + ': ' + tables.join(','));
  }
  const cardColumns = handle.prepare('PRAGMA table_info(cards)').all().map((column) => column.name);
  if (!cardColumns.includes('text')) throw new Error('cards table missing text column: ' + cardColumns.join(','));
} finally {
  handle.close();
}
await disposer();
if (registered.size !== 0) throw new Error('tools not disposed: ' + [...registered.keys()].join(','));
console.log('INDEX-REAL-OK tools=' + names.length + ' effects=' + effects.join(',') + ' cache=' + basename(dir));
await rm(dir, { recursive: true, force: true });
