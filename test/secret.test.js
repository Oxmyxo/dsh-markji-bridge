import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretBox, SECRET_KEY_FILENAME } from '../lib/secret.js';

const PLAIN = 'a'.repeat(64);

async function tempDir() {
  return mkdtemp(join(tmpdir(), 'dmb-secret-'));
}

test('encrypt/decrypt round-trips and persists the DEK in secret.key', async () => {
  const dir = await tempDir();
  try {
    const box = createSecretBox({ dataDir: dir });
    const cipher = await box.encrypt(PLAIN);
    assert.match(cipher, /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
    assert.equal(cipher.includes(PLAIN), false);
    assert.equal(await box.decrypt(cipher), PLAIN);
    assert.equal(box.source, 'file');
    const key = await readFile(join(dir, SECRET_KEY_FILENAME), 'utf8');
    assert.equal(Buffer.from(key.trim(), 'base64').length, 32);
    const reused = createSecretBox({ dataDir: dir });
    assert.equal(await reused.decrypt(cipher), PLAIN);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('tampered ciphertext, wrong key, and invalid formats are rejected', async () => {
  const dir = await tempDir();
  try {
    const box = createSecretBox({ dataDir: dir });
    const cipher = await box.encrypt(PLAIN);
    await assert.rejects(() => box.decrypt(cipher.slice(0, -2) + 'AA'), (error) => error.code === 'secret_corrupt');
    await assert.rejects(() => box.decrypt('not-a-ciphertext'), (error) => error.code === 'secret_corrupt');
    await assert.rejects(() => box.decrypt('v2:aaaa:bbbb:cccc'), (error) => error.code === 'secret_corrupt');
    await writeFile(join(dir, SECRET_KEY_FILENAME), 'not-base64!!\n');
    const broken = createSecretBox({ dataDir: dir });
    await assert.rejects(() => broken.encrypt(PLAIN), (error) => error.code === 'secret_key_invalid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing DEK is reported instead of replaced with a fresh one', async () => {
  const dir = await tempDir();
  try {
    const box = createSecretBox({ dataDir: dir });
    const cipher = await box.encrypt(PLAIN);
    await rm(join(dir, SECRET_KEY_FILENAME), { force: true });
    const missing = createSecretBox({ dataDir: dir });
    await assert.rejects(() => missing.decrypt(cipher), (error) => error.code === 'secret_key_missing');
    await assert.rejects(() => stat(join(dir, SECRET_KEY_FILENAME)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rotate replaces the DEK so old ciphertext no longer decrypts', async () => {
  const dir = await tempDir();
  try {
    const box = createSecretBox({ dataDir: dir });
    const before = await box.encrypt(PLAIN);
    const source = await box.rotate();
    assert.equal(source, 'file');
    assert.equal(await box.decrypt(await box.encrypt(PLAIN)), PLAIN);
    await assert.rejects(() => box.decrypt(before), (error) => error.code === 'secret_corrupt');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the Host credential store is preferred when no sidecar exists', async () => {
  const dir = await tempDir();
  let record = null;
  const credentials = {
    async readRecord() { return record; },
    async modifyRecord(_key, update) { record = await update(record); return record; },
  };
  try {
    const box = createSecretBox({ dataDir: dir, credentials });
    const cipher = await box.encrypt(PLAIN);
    assert.equal(box.source, 'credentials');
    assert.equal(record.kind, 'api-key');
    assert.equal(Buffer.from(record.key, 'base64').length, 32);
    const reused = createSecretBox({ dataDir: dir, credentials });
    assert.equal(await reused.decrypt(cipher), PLAIN);
    await assert.rejects(() => stat(join(dir, SECRET_KEY_FILENAME)));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('non-empty secret values are required', async () => {
  const dir = await tempDir();
  try {
    const box = createSecretBox({ dataDir: dir });
    await assert.rejects(() => box.encrypt(''), (error) => error.code === 'secret_invalid');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
