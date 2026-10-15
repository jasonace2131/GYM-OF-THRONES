import type { PaginatedData } from '@got/shared';

/**
 * Walk a paginated endpoint to the end, for an export.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * A REJECTED PAGE REJECTS THE WHOLE CALL. THERE IS NO PARTIAL RESULT.
 *
 * The failure mode this exists to prevent is a CSV that looks complete and is
 * not. A bookkeeper reconciling takings against a file missing page four
 * finds a discrepancy and has no way to tell whether it came from the export
 * or the till — and the export is the last place they would look. Better no
 * file than a plausible wrong one, so one bad page throws and the caller's
 * catch shows an error instead of a download.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Sequential rather than parallel on purpose: the console's rate limiter is
 * keyed on the authenticated user, and firing fifty pages at once from a
 * front-desk tablet is the one request pattern that looks exactly like abuse.
 *
 * `maxPages` is a hard stop, not a hint. `truncated` then reports it, and
 * `total` stays the SERVER's count, so a caller can say "N rows of M".
 */
export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<PaginatedData<T>>,
  maxPages = 50,
): Promise<{ items: T[]; total: number; truncated: boolean }> {
  const items: T[] = [];
  let total = 0;
  let page = 1;

  for (;;) {
    const result = await fetchPage(page);
    items.push(...result.items);
    total = result.total;

    // A short page ends the walk even when `totalPages` says otherwise: a row
    // voided between two requests shrinks the set, and trusting the count
    // alone would spend a round trip fetching nothing.
    if (result.items.length < result.limit) return { items, total, truncated: false };
    if (page >= result.totalPages) return { items, total, truncated: false };
    if (page >= maxPages) return { items, total, truncated: true };

    page += 1;
  }
}
