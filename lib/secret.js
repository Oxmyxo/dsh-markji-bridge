// dsh-markji-bridge: at-rest encryption for the Markji API key.
//
// The key itself lives in cache.db's secrets table as an AES-256-GCM ciphertext.
// The data-encryption key (DEK) is stored, in order of preference, in the Host
// credential store (@deepseek-ai/dsh-credentials), or in a per-profile
// secret.key sidecar with owner-only permissions. A missing DEK is an error:
// the plugin never silently falls back to a plaintext/environment token.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const SECRET_FORMAT = 'v1';
export const SECRET_KEY_FILENAME = 'secret.key';
export const CREDENTIAL_KEY = 'dsh-markji-bridge/dek';
const DEK_BYTES = 32;
const IV_BYTES = 12;

export class SecretError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SecretError';
    this.code = code;
  }
}

function b64(buffer) {
  return Buffer.from(buffer).toString('base64');
}

function unb64(text, what) {
  if (typeof text !== 'string' || text === '') throw new SecretError('secret_corrupt', 'encrypted secret has an empty ' + what);
  const value = Buffer.from(text, 'base64');
  if (value.length === 0) throw new SecretError('secret_corrupt', 'encrypted secret has an invalid ' + what);
  return value;
}

function parseDek(value) {
  if (typeof value !== 'string') return null;
  const key = Buffer.from(value.trim(), 'base64');
  return key.length === DEK_BYTES ? key : null;
}

/**
 * Create the secret box. init() is lazy; encrypt/decrypt await it.
 *
 * @param options.dataDir       profile data directory (sidecar location)
 * @param options.credentials   optional Host credentials service
 * @param options.log           optional (level, message) sink
 */
export function createSecretBox({ dataDir, credentials = null, log = () => {}, source = process.platform } = {}) {
  if (typeof dataDir !== 'string' || dataDir === '') throw new Error('createSecretBox: dataDir is required');
  const sidecar = join(dataDir, SECRET_KEY_FILENAME);
  let dek = null;
  let dekSource = null;
  let initPromise = null;

  async function readSidecar() {
    let raw;
    try {
      raw = await readFile(sidecar, 'utf8');
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw new SecretError('secret_key_unreadable', 'could not read secret.key: ' + (error && error.message ? error.message : String(error)));
    }
    const key = parseDek(raw.trim());
    if (key === null) throw new SecretError('secret_key_invalid', 'secret.key does not contain a 32-byte base64 key');
    return key;
  }

  async function readCredential() {
    if (credentials === null || typeof credentials !== 'object' || typeof credentials.readRecord !== 'function') return null;
    const record = await credentials.readRecord(CREDENTIAL_KEY);
    if (!record) return null;
    if (record.kind !== 'api-key' || typeof record.key !== 'string') {
      throw new SecretError('secret_key_invalid', 'the Host credential DEK record is malformed');
    }
    const key = parseDek(record.key);
    if (key === null) throw new SecretError('secret_key_invalid', 'the Host credential DEK is not a 32-byte key');
    return key;
  }

  async function writeCredential(key) {
    if (credentials === null || typeof credentials !== 'object' || typeof credentials.modifyRecord !== 'function') return false;
    try {
      const record = await credentials.modifyRecord(CREDENTIAL_KEY, async () => ({ kind: 'api-key', key: b64(key) }));
      return Boolean(record && record.kind === 'api-key');
    } catch (error) {
      log('warn', 'could not store the Host credential DEK: ' + (error && error.message ? error.message : String(error)));
      return false;
    }
  }

  async function writeSidecar(key) {
    await mkdir(dataDir, { recursive: true });
    await writeFile(sidecar, b64(key) + '\n', { encoding: 'utf8', mode: 0o600 });
    try {
      await chmod(sidecar, 0o600);
    } catch (error) {
      log('warn', 'could not restrict secret.key permissions: ' + (error && error.message ? error.message : String(error)));
    }
  }

  async function init(allowCreate = true) {
    if (dek !== null) return;
    if (initPromise !== null) return initPromise;
    initPromise = (async () => {
      // A sidecar is authoritative when present: it means an earlier run chose
      // the portable fallback and existing ciphertexts are bound to it.
      const fromFile = await readSidecar();
      if (fromFile !== null) {
        dek = fromFile;
        dekSource = 'file';
        return;
      }
      const fromCredential = await readCredential();
      if (fromCredential !== null) {
        dek = fromCredential;
        dekSource = 'credentials';
        return;
      }
      // Decryption must never mint a fresh DEK: that would turn a missing key
      // into an opaque corruption error instead of the explicit remediation
      // path (open settings and save the API key again).
      if (!allowCreate) throw new SecretError('secret_key_missing', 'the data-encryption key is missing; open the dsh-markji-bridge settings page and save the API Key again');
      const fresh = randomBytes(DEK_BYTES);
      if (await writeCredential(fresh)) {
        dek = fresh;
        dekSource = 'credentials';
        return;
      }
      await writeSidecar(fresh);
      dek = fresh;
      dekSource = 'file';
    })().catch((error) => {
      initPromise = null;
      throw error;
    });
    return initPromise;
  }

  function split(ciphertext) {
    if (typeof ciphertext !== 'string') throw new SecretError('secret_corrupt', 'encrypted secret must be a string');
    const parts = ciphertext.split(':');
    if (parts.length !== 4 || parts[0] !== SECRET_FORMAT) {
      throw new SecretError('secret_corrupt', 'encrypted secret has an unknown format');
    }
    const iv = unb64(parts[1], 'iv');
    const tag = unb64(parts[2], 'tag');
    const data = unb64(parts[3], 'ciphertext');
    if (iv.length !== IV_BYTES || tag.length !== 16) throw new SecretError('secret_corrupt', 'encrypted secret has invalid parameters');
    return { iv, tag, data };
  }

  async function encrypt(plain) {
    await init();
    if (typeof plain !== 'string' || plain.length === 0) throw new SecretError('secret_invalid', 'secret value must be a non-empty string');
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', dek, iv);
    const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    return SECRET_FORMAT + ':' + b64(iv) + ':' + b64(cipher.getAuthTag()) + ':' + b64(data);
  }

  async function decrypt(ciphertext) {
    await init(false);
    const { iv, tag, data } = split(ciphertext);
    try {
      const decipher = createDecipheriv('aes-256-gcm', dek, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      throw new SecretError('secret_corrupt', 'encrypted secret could not be decrypted (wrong key or tampered data)');
    }
  }

  /** Generate a new DEK. Existing ciphertext must be re-encrypted by the caller. */
  async function rotate() {
    const fresh = randomBytes(DEK_BYTES);
    let nextSource = 'file';
    if (await writeCredential(fresh)) {
      // A stale sidecar takes precedence at init(); remove it before switching.
      await rm(sidecar, { force: true });
      nextSource = 'credentials';
    } else {
      await writeSidecar(fresh);
    }
    dek = fresh;
    dekSource = nextSource;
    return nextSource;
  }

  return {
    get source() {
      return dekSource;
    },
    get initialized() {
      return dek !== null;
    },
    init,
    encrypt,
    decrypt,
    rotate,
    sidecar,
    /** Test/inspection helper: true when a DEK can be loaded without writing. */
    async hasKey() {
      try {
        await init(false);
        return true;
      } catch {
        return false;
      }
    },
    /** Platform input is accepted for diagnostics only; the current fallback is a sidecar. */
    platform: source,
  };
}
