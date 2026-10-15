import { describe, expect, it, vi } from 'vitest';
import type { PaginatedData } from '@got/shared';
import { fetchAllPages } from './reportExport';

/** A stub endpoint holding `total` rows, `limit` to a page. */
function pagedSource(total: number, limit: number) {
  const requested: number[] = [];

  const fetchPage = async (page: number): Promise<PaginatedData<string>> => {
    requested.push(page);
    const start = (page - 1) * limit;
    return {
      items: Array.from({ length: Math.max(0, Math.min(limit, total - start)) }, (_, i) =>
        String(start + i),
      ),
      total,
      page,
      limit,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    };
  };

  return { fetchPage, requested };
}

describe('fetchAllPages', () => {
  it('walks exactly ceil(total / limit) pages, in order, starting at 1', async () => {
    const { fetchPage, requested } = pagedSource(250, 100);

    const result = await fetchAllPages(fetchPage);

    expect(requested).toEqual([1, 2, 3]);
    expect(result.items).toHaveLength(250);
    expect(result.total).toBe(250);
    expect(result.truncated).toBe(false);
  });

  it('fires exactly one call when the first page holds everything', async () => {
    const { fetchPage, requested } = pagedSource(40, 100);

    const result = await fetchAllPages(fetchPage);

    // Not two. A second request for a page known to be empty is a round trip
    // per export, and on a slow counter connection it is a visible pause.
    expect(requested).toEqual([1]);
    expect(result.items).toHaveLength(40);
  });

  it('handles an empty result without looping', async () => {
    const { fetchPage, requested } = pagedSource(0, 100);

    const result = await fetchAllPages(fetchPage);

    expect(requested).toEqual([1]);
    expect(result.items).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('stops at maxPages and says so', async () => {
    const { fetchPage, requested } = pagedSource(10_000, 100);

    const result = await fetchAllPages(fetchPage, 3);

    expect(requested).toEqual([1, 2, 3]);
    expect(result.items).toHaveLength(300);
    // `total` stays the SERVER's count, not the fetched count — the footnote
    // reads "Truncated at 300 rows of 10000", which is only sayable if both
    // numbers survive.
    expect(result.total).toBe(10_000);
    expect(result.truncated).toBe(true);
  });

  /**
   * ─────────────────────────────────────────────────────────────────────────
   * A REJECTED PAGE REJECTS THE WHOLE CALL.
   *
   * The failure mode this exists to prevent is a partially-written CSV that
   * looks complete: a bookkeeper reconciling against a file missing page four
   * finds a discrepancy and has no way to tell it came from the export rather
   * than the till. Better no file than a plausible wrong one.
   * ─────────────────────────────────────────────────────────────────────────
   */
  it('rejects the whole call when any page fails, with no partial result', async () => {
    const fetchPage = vi.fn(async (page: number): Promise<PaginatedData<string>> => {
      if (page === 3) throw new Error('network');
      return { items: ['a', 'b'], total: 100, page, limit: 2, totalPages: 50 };
    });

    await expect(fetchAllPages(fetchPage)).rejects.toThrow('network');
    // It stopped rather than carrying on to page 4.
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('stops early if the server returns a short page', async () => {
    // A row voided between page 1 and page 2 shrinks the result set. Trusting
    // `totalPages` alone would then request a page that comes back empty.
    let call = 0;
    const fetchPage = async (page: number): Promise<PaginatedData<string>> => {
      call += 1;
      return { items: call === 1 ? ['a', 'b'] : [], total: 4, page, limit: 2, totalPages: 2 };
    };

    const result = await fetchAllPages(fetchPage);

    expect(result.items).toEqual(['a', 'b']);
    expect(result.truncated).toBe(false);
  });
});
