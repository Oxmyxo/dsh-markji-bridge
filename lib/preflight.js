/**
 * dsh-markji-bridge - shared write/push preflight.
 *
 * One implementation of "is this card content safe to write?" used by both
 * lib/tools.js (before a create/update is queued) and lib/sync.js (before a
 * queued write reaches the provider). It checks the raw Markji syntax with
 * lib/card-syntax.js and, when a client is supplied, batch-queries the
 * referenced Pic/Audio file ids so a missing upload is reported at the call
 * instead of after the next push.
 *
 * preflightContent(content, { client, batchSize }) -> Promise<{
 *   ok, errors: Issue[], warnings: Issue[], media: MediaRef[],
 * }>
 *   client: a Markji client exposing queryFiles({ ids }); omit/null to skip
 *     the media query and report syntax plus the referenced media ids only.
 *   batchSize: media ids per queryFiles request; capped at 100 (provider limit).
 *
 * Issue = { code, message, line, column, path, media? }
 * MediaRef = { kind: 'image'|'mask'|'audio', id, line, column }
 */
import { validateCardContent } from './card-syntax.js';

/** queryFiles accepts at most 100 ids per request. */
export const MAX_MEDIA_QUERY_BATCH = 100;

function mediaKey(ref) {
  return ref.kind + ':' + ref.id;
}

function mediaBatchSize(value) {
  if (!Number.isInteger(value) || value <= 0) return MAX_MEDIA_QUERY_BATCH;
  return Math.min(value, MAX_MEDIA_QUERY_BATCH);
}

function mediaIssue(ref, message, code = 'media_unavailable') {
  return {
    code,
    message,
    line: Number.isInteger(ref.line) ? ref.line : null,
    column: Number.isInteger(ref.column) ? ref.column : null,
    path: null,
    media: { kind: ref.kind, id: ref.id },
  };
}

function errorMessage(error) {
  if (error === null || error === undefined) return 'unknown error';
  if (typeof error === 'object' && typeof error.message === 'string' && error.message !== '') return error.message;
  return String(error);
}

/**
 * Deduplicate media references by kind + id, preserving the first position.
 * The same file may be referenced as both an image and a mask, so kind stays
 * part of the key.
 */
export function uniqueMedia(media) {
  const seen = new Set();
  const out = [];
  for (const ref of Array.isArray(media) ? media : []) {
    if (ref === null || typeof ref !== 'object') continue;
    if (typeof ref.id !== 'string' || ref.id === '' || typeof ref.kind !== 'string') continue;
    const key = mediaKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * Query the provider for the given ids in requests of at most batchSize ids and
 * return the set of ids the provider still knows. Throws when the client is
 * unusable or a request fails, so callers can report media_check_failed.
 */
export async function queryAvailableMedia(client, ids, batchSize) {
  if (client === null || typeof client !== 'object' || typeof client.queryFiles !== 'function') {
    throw new Error('preflight: client.queryFiles is not available');
  }
  const list = [...new Set(Array.from(ids ?? []).filter((id) => typeof id === 'string' && id !== ''))];
  const size = mediaBatchSize(batchSize);
  const available = new Set();
  for (let offset = 0; offset < list.length; offset += size) {
    const files = await client.queryFiles({ ids: list.slice(offset, offset + size) });
    for (const file of Array.isArray(files) ? files : []) {
      if (file !== null && typeof file === 'object' && typeof file.id === 'string' && file.id !== '') available.add(file.id);
    }
  }
  return available;
}

/** Media references whose id the provider did not return in available. */
export function missingMedia(media, available) {
  const known = available instanceof Set ? available : new Set();
  return uniqueMedia(media).filter((ref) => !known.has(ref.id));
}

/**
 * Preflight one card body: raw Markji syntax plus (optionally) media
 * availability. Never throws for bad content; a failed media query becomes a
 * media_check_failed error so the caller can keep the item queued/retryable.
 */
export async function preflightContent(content, options = {}) {
  const validation = validateCardContent(content);
  const errors = Array.isArray(validation.errors) ? validation.errors.slice() : [];
  const warnings = Array.isArray(validation.warnings) ? validation.warnings.slice() : [];
  const media = uniqueMedia(validation.media);
  if (!validation.ok || media.length === 0) {
    return { ok: errors.length === 0, errors, warnings, media };
  }
  const batchSize = mediaBatchSize(options.batchSize);
  let available = null;
  if (options.availableMedia instanceof Set) {
    available = options.availableMedia;
  } else if (options.client !== undefined && options.client !== null) {
    try {
      available = await queryAvailableMedia(options.client, media.map((ref) => ref.id), batchSize);
    } catch (error) {
      errors.push({
        code: 'media_check_failed',
        message: 'media availability could not be checked: ' + errorMessage(error),
        line: null,
        column: null,
        path: null,
        media: media.map((ref) => ({ kind: ref.kind, id: ref.id })),
      });
      return { ok: false, errors, warnings, media };
    }
  }
  if (available !== null) {
    for (const ref of missingMedia(media, available)) {
      errors.push(mediaIssue(ref, 'referenced ' + ref.kind + ' file ' + ref.id + ' is not available in Markji'));
    }
  }
  return { ok: errors.length === 0, errors, warnings, media };
}
