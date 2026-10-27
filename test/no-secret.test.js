// Guard against committing a Markji OpenAPI token or any other 64-hex secret.
// The plugin reads its token from the encrypted cache (settings page); the old
// cordis.patch.yml/env fallback is migration-only and must stay empty.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const HEX64 = /(?:^|[^0-9a-fA-F])[0-9a-fA-F]{64}(?:[^0-9a-fA-F]|$)/;
const SKIP_DIRS = new Set(['.git', 'node_modules', '.cache', 'coverage', 'dist']);
const MAX_BYTES = 4 * 1024 * 1024;

async function files(dir, out = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await files(join(dir, entry.name), out);
      continue;
    }
    if (!entry.isFile()) continue;
    const path = join(dir, entry.name);
    try {
      if (statSync(path).size > MAX_BYTES) continue;
    } catch {
      continue;
    }
    out.push(path);
  }
  return out;
}

function looksText(buffer) {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) if (byte === 0) return false;
  return true;
}

test('the repository contains no hard-coded 64-hex secret', async () => {
  const hits = [];
  for (const path of await files(ROOT)) {
    let buffer;
    try {
      buffer = readFileSync(path);
    } catch {
      continue;
    }
    if (!looksText(buffer)) continue;
    const text = buffer.toString('utf8');
    const match = HEX64.exec(text);
    if (match) hits.push(relative(ROOT, path) + ': ' + match[0].slice(0, 4) + '…' + match[0].slice(-4));
  }
  assert.deepEqual(hits, [], 'possible 64-hex secret(s) found; use markji_sync settings or a generated test fixture');
});
