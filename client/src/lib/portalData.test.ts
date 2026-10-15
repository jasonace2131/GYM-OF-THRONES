import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from './api';
import { formatCentavos, formatCivilDate, getSubscription } from './portalData';

const MEMBERSHIP = {
  id: 'm1',
  userId: 'u1',
  memberCode: 'K7QX2M',
  firstName: 'Juan',
  lastName: 'Dela Cruz',
  planId: 'p1',
  planCode: 'MONTHLY',
  planName: 'Monthly',
  status: 'ACTIVE',
  startsOn: '2026-08-01',
  endsOn: '2026-08-31',
  graceDays: 3,
  cancelRequestedOn: null,
  decision: 'ALLOW',
  allowReason: 'MEMBERSHIP_ACTIVE',
  denialReason: null,
  daysRemaining: 12,
  planPriceCentavos: 80000,
  termMonths: 1,
  billingAnchorDay: 1,
  joinedOn: '2024-03-15',
  cancelledOn: null,
  graceAdmissionsThisTerm: 0,
  freezesUsedThisTerm: 0,
  guestPassesPerTerm: 0,
  guestPassesRemaining: 0,
  purchasedAt: '2026-08-01T02:14:00.000Z',
  verdict: {
    decision: 'ALLOW',
    verdict: 'ALLOWED',
    allowReason: 'MEMBERSHIP_ACTIVE',
    denialReason: null,
    message: 'Monthly — active until 31 Aug (12 days left). Let them in.',
    relevantDate: '2026-08-31',
    daysRemaining: 12,
    graceDaysRemaining: 0,
    offer: 'NONE',
  },
  hold: null,
  events: [],
};

describe('formatCentavos', () => {
  it('composes the only peso string in the system, from an integer the server sent', () => {
    expect(formatCentavos(80000)).toBe('₱800.00');
    expect(formatCentavos(9000)).toBe('₱90.00');
    expect(formatCentavos(220000)).toBe('₱2,200.00');
    expect(formatCentavos(750000)).toBe('₱7,500.00');
  });

  it('renders a ₱0 comp rather than an empty cell', () => {
    expect(formatCentavos(0)).toBe('₱0.00');
  });

  it('renders sub-peso centavos exactly — 20% of a VAT base is rarely round', () => {
    expect(formatCentavos(14285)).toBe('₱142.85');
  });
});

describe('formatCivilDate', () => {
  it('formats a server civil date with UTC accessors, never the device zone', () => {
    expect(formatCivilDate('2026-08-31')).toBe('31 Aug 2026');
    // 00:00–08:00 Manila is the previous UTC day: the old iso() bug. A civil
    // date must not shift no matter what the browser thinks the time is.
    expect(formatCivilDate('2026-01-01')).toBe('1 Jan 2026');
  });
});

describe('getSubscription', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('calls the three live endpoints and returns the server verdict verbatim', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({ membership: MEMBERSHIP, verdict: MEMBERSHIP.verdict })
      .mockResolvedValueOnce([
        {
          id: 'p1',
          code: 'MONTHLY',
          name: 'Monthly',
          description: null,
          kind: 'TERM',
          priceCentavos: 80000,
          termMonths: 1,
          guestPassesPerTerm: 0,
          perks: [],
          sortOrder: 1,
        },
      ])
      .mockResolvedValueOnce({
        items: [
          {
            id: 'pay1',
            businessDate: '2026-08-01',
            netCentavos: 80000,
            method: 'GCASH',
            status: 'RECORDED',
            reference: 'GC-8842019',
          },
        ],
        page: 1,
        limit: 12,
        total: 1,
        totalPages: 1,
      });

    const data = await getSubscription();

    expect(vi.mocked(apiFetch).mock.calls.map((call) => call[0])).toEqual([
      '/me/membership',
      '/plans',
      '/me/payments?page=1&limit=12',
    ]);
    expect(data.membership?.status).toBe('ACTIVE');
    expect(data.verdict.message).toBe(MEMBERSHIP.verdict.message);
    expect(data.plans[0].priceCentavos).toBe(80000);
    expect(data.payments[0].netCentavos).toBe(80000);
  });

  it('renders "no membership" as a valid state rather than an error', async () => {
    vi.mocked(apiFetch)
      .mockResolvedValueOnce({
        membership: null,
        verdict: {
          decision: 'DENY',
          verdict: null,
          allowReason: null,
          denialReason: 'NO_MEMBERSHIP',
          message: 'No plan on file. Ask the front desk — Monthly is ₱800.',
          relevantDate: null,
          daysRemaining: null,
          graceDaysRemaining: 0,
          offer: 'RENEW',
        },
      })
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce({ items: [], page: 1, limit: 12, total: 0, totalPages: 0 });

    const data = await getSubscription();

    expect(data.membership).toBeNull();
    expect(data.verdict.denialReason).toBe('NO_MEMBERSHIP');
    expect(data.payments).toEqual([]);
  });
});
