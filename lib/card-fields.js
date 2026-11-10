// Shared card read projection contract; filters remain independent of output fields.
import { MarkjiError } from './api.js';

export const CARD_READ_FIELDS = Object.freeze([
  'id', 'content', 'deck_id', 'deck_name', 'chapter_id', 'chapter_name',
  'status', 'text', 'snippet', 'grammar_version', 'revision', 'updated_time',
  'created_time', 'local', 'pending', 'conflict', 'last_error', 'cloud',
]);
const allowed = new Set(CARD_READ_FIELDS);

export function readCardFields(args = {}) {
  const fields = args.include_fields;
  if (fields !== undefined && !Array.isArray(fields)) {
    throw new MarkjiError({ code: 'invalid_argument', message: 'include_fields must be an array of card field names', retriable: false });
  }
  const extra = new Set();
  for (const field of fields ?? []) {
    if (typeof field !== 'string' || !allowed.has(field)) {
      throw new MarkjiError({ code: 'invalid_argument', message: 'Unknown card output field in include_fields: ' + String(field) + '. Allowed: ' + CARD_READ_FIELDS.join(', '), retriable: false });
    }
    if (field !== 'id' && field !== 'content') extra.add(field);
  }
  if (args.include_text !== undefined && typeof args.include_text !== 'boolean') {
    throw new MarkjiError({ code: 'invalid_argument', message: 'include_text must be a boolean', retriable: false });
  }
  if (args.include_text === true) extra.add('text');
  return [...extra];
}

// Return a fresh object, never delete metadata from a cached record or engine result.
export function projectCardFields(card, fields) {
  const result = { id: card.id, content: card.content };
  for (const field of fields) result[field] = card[field] ?? (field === 'local' ? false : null);
  return result;
}
