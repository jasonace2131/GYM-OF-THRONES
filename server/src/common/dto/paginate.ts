import type { PaginatedData } from '@got/shared';
import type { PaginationQueryDto } from './pagination-query.dto';

/**
 * The one place offset pagination is computed. Written once because
 * `(page - 1) * limit` inlined at each call site is exactly the arithmetic
 * that gets an off-by-one and silently drops or repeats a row per page.
 */
export function paginationSkipTake(query: PaginationQueryDto): { skip: number; take: number } {
  return { skip: (query.page - 1) * query.limit, take: query.limit };
}

/**
 * The one place `PaginatedData<T>` is built.
 *
 * `totalPages` floors at 1 for an empty result: a client rendering "page 1 of
 * 0" is a bug report, and every list has a first page even when it is empty.
 */
export function paginated<T>(
  items: T[],
  total: number,
  query: PaginationQueryDto,
): PaginatedData<T> {
  return {
    items,
    total,
    page: query.page,
    limit: query.limit,
    totalPages: Math.max(1, Math.ceil(total / query.limit)),
  };
}
