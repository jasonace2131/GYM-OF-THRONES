import { describe, expect, it } from 'vitest';
import type { CivilDate } from '@/lib/gymTime';
import {
  DEFAULT_FILTERS,
  activeFilterCount,
  csvFileStem,
  historyProblem,
  historyQuery,
  historySearch,
  memberHistoryHref,
  parseHistory,
  windowOf,
  type HistoryFilters,
} from './historyFilters';

const TODAY = '2026-11-09' as CivilDate;
const ANA = '33333333-3333-4333-8333-333333333333';
const f = (over: Partial<HistoryFilters> = {}): HistoryFilters => ({ ...DEFAULT_FILTERS, ...over });
const parse = (qs: string): HistoryFilters => parseHistory(new URLSearchParams(qs));

describe('windowOf', () => {
  it('turns each quick pick into gym dates', () => {
    expect(windowOf(f({ period: 'today' }), TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(windowOf(f({ period: '7d' }), TODAY)).toEqual({ from: '2026-11-03', to: TODAY });
    expect(windowOf(f({ period: '30d' }), TODAY)).toEqual({ from: '2026-10-11', to: TODAY });
    expect(windowOf(f({ period: 'month' }), TODAY)).toEqual({ from: '2026-11-01', to: TODAY });
    expect(windowOf(f({ period: 'last' }), TODAY)).toEqual({
      from: '2026-10-01',
      to: '2026-10-31',
    });
    expect(windowOf(f({ period: 'all' }), TODAY)).toBeNull();
  });

  it('handles last month across a year end', () => {
    expect(windowOf(f({ period: 'last' }), '2027-01-15' as CivilDate)).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});

describe('the address', () => {
  it('round-trips every filter, leaving defaults out', () => {
    const filters = f({
      period: 'custom',
      from: '2026-10-01' as CivilDate,
      to: '2026-10-31' as CivilDate,
      member: ANA,
      q: 'ana',
      type: 'WALK_IN',
      how: 'MANUAL',
      status: 'voided',
      page: 3,
    });
    const search = historySearch(filters);
    expect(parse(search.slice(1))).toEqual(filters);
    expect(historySearch(DEFAULT_FILTERS)).toBe('?view=history');
  });

  it('falls back to the defaults on anything malformed', () => {
    expect(
      parse('period=yesterday&type=VIP&how=telepathy&status=gone&member=nope&page=-2'),
    ).toEqual(DEFAULT_FILTERS);
    expect(parse('period=custom&from=2026-02-31&to=2026-03-01').period).toBe('7d');
  });

  it("links the member drawer to that member's whole history", () => {
    expect(memberHistoryHref(ANA)).toBe(`/admin/attendance?view=history&period=all&member=${ANA}`);
  });
});

describe('historyProblem (the server rules, asked in advance)', () => {
  it('allows all time only for one member', () => {
    expect(historyProblem(f({ period: 'all' }), TODAY)).toMatch(/one member/);
    expect(historyProblem(f({ period: 'all', member: ANA }), TODAY)).toBeNull();
  });

  it('refuses a backwards range, and over a year for everyone', () => {
    const backwards = f({
      period: 'custom',
      from: '2026-11-09' as CivilDate,
      to: '2026-11-01' as CivilDate,
    });
    expect(historyProblem(backwards, TODAY)).toMatch(/after the To date/);
    const long = f({ period: 'custom', from: '2025-01-01' as CivilDate, to: TODAY });
    expect(historyProblem(long, TODAY)).toMatch(/366 days/);
    expect(historyProblem({ ...long, member: ANA }, TODAY)).toBeNull();
  });
});

describe('historyQuery', () => {
  it('sends only what narrows the list', () => {
    expect(historyQuery(f(), TODAY)).toEqual({ from: '2026-11-03', to: TODAY });
    expect(
      historyQuery(
        f({
          period: 'all',
          member: ANA,
          q: ' a ',
          type: 'GUEST_PASS',
          how: 'STATION_QR',
          status: 'inside',
        }),
        TODAY,
      ),
    ).toEqual({ userId: ANA, entryType: 'GUEST_PASS', method: 'STATION_QR', openOnly: true });
    expect(historyQuery(f({ q: ' rey ', status: 'voided' }), TODAY)).toMatchObject({
      q: 'rey',
      includeVoided: true,
    });
  });
});

describe('small helpers', () => {
  it('counts the filters beyond the period', () => {
    expect(activeFilterCount(f())).toBe(0);
    expect(activeFilterCount(f({ member: ANA, how: 'MANUAL', period: '30d' }))).toBe(2);
  });

  it('names the download for the range and the member', () => {
    expect(csvFileStem(f(), TODAY, null)).toBe('got-attendance-2026-11-03-to-2026-11-09');
    expect(csvFileStem(f({ period: 'all', member: ANA }), TODAY, 'Ana Dela Cruz')).toBe(
      'got-attendance-ana-dela-cruz-all-time',
    );
  });
});

describe('summaryQuery', () => {
  it('drops "Include voided": voided visits are shown, never counted', async () => {
    const { summaryQuery } = await import('./historyFilters');
    expect(summaryQuery(f({ status: 'voided' }), TODAY)).toEqual({ from: '2026-11-03', to: TODAY });
    expect(summaryQuery(f({ status: 'inside' }), TODAY)).toMatchObject({ openOnly: true });
  });
});
