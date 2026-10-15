/**
 * GCash reference normalization.
 *
 * GCash publishes no merchant-facing reference spec. Observed reality: real
 * references are 10–13 characters, purely numeric on newer formats,
 * ALPHANUMERIC on older ones, and a bank-funded arrival carries a 14-digit
 * InstaPay reference (FTOB-20190927-000141, keyed as 20190927000141). The
 * app also renders one reference with and without grouping spaces —
 * 6028871884223 vs 6028 871 884223 — so equality must be decided on the
 * normalized form or duplicate detection silently never fires.
 *
 * `looksLikeGcashReference` returning false is a UI HINT, never a refusal —
 * a `^\d{13}$` validator would refuse legitimate money at the counter. Do
 * not tighten it.
 */

/** Uppercase, strip everything that is not A–Z or 0–9. */
export function normalizeGcashReference(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** The usual shape. FALSE IS NOT AN ERROR — it drives a hint, never a refusal. */
export function looksLikeGcashReference(normalized: string): boolean {
  return /^\d{13}$/.test(normalized);
}
