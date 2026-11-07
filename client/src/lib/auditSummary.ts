import type { AuditEntry } from './adminApi';

/** Longer than this and a value is free text, not a figure a manager compares. */
const LONG = 80;
const CLIPPED = 60;

/**
 * Actions whose details are free text the subject label already sums up — the
 * assistant's instructions, up to 6,000 characters each side, under a label
 * that reads "N → M characters".
 */
const TEXT_ONLY: ReadonlySet<AuditEntry['action']> = new Set([
  'ASSISTANT_INSTRUCTIONS_UPDATED',
  'ASSISTANT_INSTRUCTIONS_RESET',
]);

/** Cut by code point, so an emoji is never split into a broken glyph. */
function clip(value: unknown): string {
  const text = String(value);
  const points = Array.from(text);
  return points.length > LONG ? `${points.slice(0, CLIPPED).join('')}…` : text;
}

/**
 * `{ before, after }` and `{ days: [...] }` rendered as one readable line.
 *
 * Deliberately not a JSON dump. An audit screen that shows raw payloads is one
 * only its author can read, and the whole value of the column is that a
 * manager can see "priceCentavos 80000 → 90000" without asking anybody.
 *
 * The line sits in a `nowrap` cell of an auto-layout table, so one long value
 * stretches the column for the whole page and pushes "Why" off the screen —
 * hence `clip` on everything printed, and nothing printed for TEXT_ONLY.
 */
export function summariseAuditDetails(
  action: AuditEntry['action'],
  details: unknown,
): string | null {
  if (details === null || typeof details !== 'object') return null;
  if (TEXT_ONLY.has(action)) return null;
  const record = details as Record<string, unknown>;
  if (action === 'ROLE_PERMISSIONS_UPDATED') return summariseRoleAccess(record);

  const parts: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    if (value !== null && typeof value === 'object' && 'before' in value && 'after' in value) {
      const pair = value as { before: unknown; after: unknown };
      parts.push(`${key}: ${clip(pair.before)} → ${clip(pair.after)}`);
    } else if (
      Array.isArray(value) &&
      value.length > 0 &&
      value.every((item) => typeof item === 'string')
    ) {
      // A list of names — the progress entries' `fields` — reads as the names.
      parts.push(`${key}: ${clip(value.join(', '))}`);
    } else if (Array.isArray(value)) {
      parts.push(`${key}: ${value.length}`);
    } else if (value !== null && typeof value !== 'object') {
      parts.push(`${key}: ${clip(value)}`);
    }
  }

  return parts.length === 0 ? null : parts.join(' · ');
}

const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const objects = (value: unknown): Array<Record<string, unknown>> =>
  Array.isArray(value)
    ? value.filter(
        (item): item is Record<string, unknown> => item !== null && typeof item === 'object',
      )
    : [];

/**
 * Edit role access: `{ role, reset, added, removed, changed }` as
 * "on: payment.void · off: shift.manage · reach: member.read Own → All".
 * The role itself is the entry's subject label, so it is not repeated.
 */
function summariseRoleAccess(record: Record<string, unknown>): string | null {
  const reach = (scope: unknown): string => (scope === 'OWN' ? 'Own' : 'All');
  const added = objects(record['added']).map((g) =>
    g['scope'] === 'OWN' ? `${String(g['key'])} (Own)` : String(g['key']),
  );
  const removed = strings(record['removed']);
  const changed = objects(record['changed']).map(
    (c) => `${String(c['key'])} ${reach(c['from'])} → ${reach(c['to'])}`,
  );
  const parts = [
    record['reset'] === true ? 'reset to defaults' : null,
    added.length > 0 ? `on: ${clip(added.join(', '))}` : null,
    removed.length > 0 ? `off: ${clip(removed.join(', '))}` : null,
    changed.length > 0 ? `reach: ${clip(changed.join(', '))}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' · ');
}
