import { createHash } from 'node:crypto';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      sorted[key] = sortValue(source[key]);
    }
    return sorted;
  }
  return value;
}

/**
 * JSON with every object key sorted, at every depth.
 *
 * Array order is preserved deliberately: `[1,2]` and `[2,1]` are different
 * requests. Key order and whitespace are not — two clients serialising the
 * same object must produce the same hash, or a legitimate retry looks like
 * key reuse and 409s at the counter.
 */
export function canonicalise(body: unknown): string {
  return JSON.stringify(sortValue(body)) ?? 'null';
}

/** sha256 of the canonical form. 64 hex characters — the width of the column. */
export function hashRequestBody(body: unknown): string {
  return createHash('sha256')
    .update(canonicalise(body ?? {}))
    .digest('hex');
}
