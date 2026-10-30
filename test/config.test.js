import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { defaultDataDir, legacyDataDir, migrateLegacyCache, readConfig, resolveDataDir } from '../index.js';

const NEW = 'MAIMEMO_MARKJI_OPENAPI_TOKEN';
const OLD = 'MAIMEMO_OPENAPI_TOKEN';

function withEnv(values, run) {
  const previous = {};
  for (const key of [NEW, OLD]) {
    previous[key] = process.env[key];
    delete process.env[key];
  }
  Object.assign(process.env, values);
  try {
    return run();
  } finally {
    for (const key of [NEW, OLD]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

test('readConfig reads the Markji token from MAIMEMO_MARKJI_OPENAPI_TOKEN', () => {
  withEnv({ [NEW]: ' new-token ' }, () => {
    assert.equal(readConfig({}).apiKey, 'new-token');
  });
});

test('the new env var wins over the legacy name, and an explicit apiKey wins over both', () => {
  withEnv({ [NEW]: 'new-token', [OLD]: 'old-token' }, () => {
    assert.equal(readConfig({}).apiKey, 'new-token');
    assert.equal(readConfig({ apiKey: ' explicit ' }).apiKey, 'explicit');
  });
});

test('the legacy env var still works as a fallback', () => {
  withEnv({ [OLD]: 'old-token' }, () => {
    assert.equal(readConfig({}).apiKey, 'old-token');
  });
});

test('checkMediaOnWrite defaults to true and accepts false', () => {
  withEnv({}, () => {
    assert.equal(readConfig({}).checkMediaOnWrite, true);
    assert.equal(readConfig({ checkMediaOnWrite: false }).checkMediaOnWrite, false);
    assert.equal(readConfig({ checkMediaOnWrite: 'off' }).checkMediaOnWrite, false);
  });
});

test('the default data dir is <home>/.dsh/dsh-markji-bridge and is portable', () => {
  const expected = join(homedir(), '.dsh', 'dsh-markji-bridge');
  assert.equal(defaultDataDir(), expected);
  assert.equal(resolveDataDir(''), expected);
  assert.equal(resolveDataDir('   '), expected);
  assert.ok(isAbsolute(defaultDataDir()));
  assert.ok(defaultDataDir().endsWith(join('.dsh', 'dsh-markji-bridge')));
});

test('an explicit dataDir is trimmed and returned verbatim', () => {
  assert.equal(resolveDataDir('  /tmp/some cache  '), '/tmp/some cache');
  assert.equal(resolveDataDir('relative/cache'), 'relative/cache');
});

test('legacyDataDir points at the earlier local data directory', () => {
  assert.equal(legacyDataDir(), join(homedir(), '.dsh', 'markji-bridge'));
  assert.notEqual(legacyDataDir(), defaultDataDir());
});

test('migrateLegacyCache copies cache.db and SQLite sidecars, keeping the legacy files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'markji-migrate-'));
  try {
    const legacy = join(root, 'legacy');
    const target = join(root, 'target', 'nested');
    await mkdir(legacy, { recursive: true });
    await writeFile(join(legacy, 'cache.db'), 'database-bytes');
    await writeFile(join(legacy, 'cache.db-wal'), 'wal-bytes');
    const logs = [];
    const migrated = migrateLegacyCache(legacy, target, (level, message) => logs.push([level, message]));
    assert.equal(migrated, true);
    assert.equal(await readFile(join(target, 'cache.db'), 'utf8'), 'database-bytes');
    assert.equal(await readFile(join(target, 'cache.db-wal'), 'utf8'), 'wal-bytes');
    assert.equal(await readFile(join(legacy, 'cache.db'), 'utf8'), 'database-bytes', 'legacy file must be kept');
    assert.deepEqual(logs.map((entry) => entry[0]), ['info']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migrateLegacyCache never overwrites an existing target cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'markji-migrate-'));
  try {
    const legacy = join(root, 'legacy');
    const target = join(root, 'target');
    await mkdir(legacy, { recursive: true });
    await mkdir(target, { recursive: true });
    await writeFile(join(legacy, 'cache.db'), 'old');
    await writeFile(join(target, 'cache.db'), 'current');
    assert.equal(migrateLegacyCache(legacy, target), false);
    assert.equal(await readFile(join(target, 'cache.db'), 'utf8'), 'current');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('migrateLegacyCache is a no-op without a legacy cache or valid paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'markji-migrate-'));
  try {
    assert.equal(migrateLegacyCache(join(root, 'missing'), join(root, 'target')), false);
    assert.equal(migrateLegacyCache('', join(root, 'target')), false);
    assert.equal(migrateLegacyCache(null, join(root, 'target')), false);
    await assert.rejects(stat(join(root, 'target')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('the package manifest is ready for a public release', async () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.name, 'dsh-markji-bridge');
  assert.equal(pkg.version, '2.7.1');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.license, 'MIT');
  assert.match(pkg.engines.node, />=22\.13\.0/);
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(pkg.files.includes('LICENSE'));
  assert.ok(pkg.files.includes('README.md'));
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');
  assert.match(patch, /- id: dsh-markji-bridge/);
  assert.match(patch, /name: dsh-markji-bridge/);
});
