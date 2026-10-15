/**
 * Cursor pagination over one thread's messages — pure, so the ordering rules
 * are tested as rules.
 *
 * The cursor is a MESSAGE ID the client already holds. The service resolves
 * it to `(createdAt, id)` inside the same thread, and pages strictly past it
 * with `id` as the tie-break — two messages can share a millisecond, and a
 * `createdAt`-only cursor would skip or repeat one of them.
 *
 *   latest  the newest page (first open of a thread)
 *   before  older than the cursor ("load earlier")
 *   after   newer than the cursor — THE CATCH-UP READ. Broadcast does not
 *           guarantee delivery, so the client asks for everything after the
 *           last message it holds on subscribe, reconnect and focus.
 *
 * Every page comes back OLDEST FIRST whichever way it was read.
 */

export type PageDirection = 'latest' | 'before' | 'after';

export const CHAT_PAGE_DEFAULT = 50;
export const CHAT_PAGE_MAX = 100;

export interface CursorPoint {
  id: string;
  createdAt: Date;
}

type Order = 'asc' | 'desc';

export interface PageQuery {
  where: object;
  orderBy: [{ createdAt: Order }, { id: Order }];
  take: number;
}

export function clampLimit(limit: number | undefined): number {
  if (limit === undefined) return CHAT_PAGE_DEFAULT;
  return Math.min(CHAT_PAGE_MAX, Math.max(1, Math.trunc(limit)));
}

/** One row more than asked for: its presence is `hasMore`. */
export function pageQuery(
  direction: PageDirection,
  cursor: CursorPoint | null,
  limit: number,
): PageQuery {
  const take = limit + 1;
  if (direction === 'after' && cursor !== null) {
    return {
      where: {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: cursor.id } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take,
    };
  }
  if (direction === 'before' && cursor !== null) {
    return {
      where: {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: cursor.id } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take,
    };
  }
  return { where: {}, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take };
}

export function shapePage<T>(
  rows: readonly T[],
  direction: PageDirection,
  limit: number,
): { rows: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit;
  const page = rows.slice(0, limit);
  return { rows: direction === 'after' ? page : [...page].reverse(), hasMore };
}
