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
if (names.length !== 18) throw new Error('expected 18 tools, got ' + names.length + ': ' + names.join(','));
const expected = ['markji_decks','markji_chapters','markji_cards','markji_search','markji_card_get','markji_card_syntax','markji_card_create','markji_card_update','markji_card_editor','markji_card_archive','markji_cards_move','markji_chapters_edit','markji_sync','markji_sync_status','markji_failures','markji_status','markji_conflict_resolve','markji_file'];
for (const name of expected) if (!registered.has(name)) throw new Error('missing tool ' + name);
const statusDef = registered.get('markji_status');
const status = await statusDef.execute({});
if (!status || !status.cache || typeof status.cache.cards !== 'number') throw new Error('status tool output: ' + JSON.stringify(status));
if (status.version !== '1.1.0') throw new Error('status version: ' + status.version);
if (!status.cache || typeof status.cache.bytes !== 'number') throw new Error('status cache: ' + JSON.stringify(status.cache));
const handle = new DatabaseSync(join(dir, 'cache.db'), { readOnly: true });
try {
  const version = handle.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get();
  if (!version || Number(version.value) !== 4) throw new Error('cache.db schema_version: ' + JSON.stringify(version));
  const tables = handle.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((row) => row.name);
  for (const table of ['meta', 'decks', 'chapters', 'cards', 'conflicts', 'moves', 'tasks']) {
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
