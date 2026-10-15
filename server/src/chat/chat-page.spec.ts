import { CHAT_PAGE_DEFAULT, CHAT_PAGE_MAX, clampLimit, pageQuery, shapePage } from './chat-page';

const at = (iso: string): Date => new Date(iso);

describe('clampLimit', () => {
  it('defaults, floors at 1 and caps at the maximum', () => {
    expect(clampLimit(undefined)).toBe(CHAT_PAGE_DEFAULT);
    expect(clampLimit(0)).toBe(1);
    expect(clampLimit(5)).toBe(5);
    expect(clampLimit(10_000)).toBe(CHAT_PAGE_MAX);
  });
});

describe('pageQuery', () => {
  const cursor = { id: 'b', createdAt: at('2026-09-25T02:00:00.000Z') };

  it('latest: newest first, no bound, one extra row to learn hasMore', () => {
    expect(pageQuery('latest', null, 20)).toEqual({
      where: {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
  });

  it('before: strictly older than the cursor, ties broken by id', () => {
    expect(pageQuery('before', cursor, 20)).toEqual({
      where: {
        OR: [
          { createdAt: { lt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { lt: 'b' } },
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 21,
    });
  });

  it('after: strictly newer than the cursor, oldest first — the catch-up read', () => {
    expect(pageQuery('after', cursor, 20)).toEqual({
      where: {
        OR: [
          { createdAt: { gt: cursor.createdAt } },
          { createdAt: cursor.createdAt, id: { gt: 'b' } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 21,
    });
  });
});

describe('shapePage', () => {
  const row = (id: string) => ({ id });

  it('always returns oldest first, and trims the extra row into hasMore', () => {
    // latest/before read newest first.
    expect(shapePage([row('c'), row('b'), row('a')], 'latest', 2)).toEqual({
      rows: [row('b'), row('c')],
      hasMore: true,
    });
    expect(shapePage([row('b'), row('a')], 'before', 2)).toEqual({
      rows: [row('a'), row('b')],
      hasMore: false,
    });
    // after reads oldest first already.
    expect(shapePage([row('d'), row('e'), row('f')], 'after', 2)).toEqual({
      rows: [row('d'), row('e')],
      hasMore: true,
    });
  });
});
