// Held by test/multiprocess.test.js: acquire the cache writer lock in a real
// separate process, signal readiness, then release after a short delay.
import { writeFile } from 'node:fs/promises';
import { createStore } from '../lib/store.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const dir = process.argv[2];
const marker = process.argv[3];
const store = createStore({ dataDir: dir, log: () => {} });
try {
  await store.load();
  await store.withWriteLock(async () => {
    await writeFile(marker, 'locked');
    await sleep(400);
  }, { timeoutMs: 5000 });
} finally {
  await store.close();
}
