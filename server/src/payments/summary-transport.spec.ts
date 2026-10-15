import { Logger } from '@nestjs/common';
import { LoggingSummaryTransport } from './summary-transport';
import type { OwnerSummaryPayload } from './reports.service';
import { asCivilDate } from '../common/time/gym-time';

function payload(): OwnerSummaryPayload {
  return {
    businessDate: asCivilDate('2026-08-19'),
    cash: {
      openingFloatCentavos: 200000,
      expectedCentavos: 1245000,
      countedCentavos: 1244000,
      varianceCentavos: -1000,
      countedByName: 'Ana Cruz',
    },
    gcash: { count: 3, totalCentavos: 240000 },
    newMemberships: [{ name: 'Juan Dela Cruz', planCode: 'MONTHLY' }],
    renewals: [{ name: 'Maria Santos', planCode: 'QUARTERLY' }],
    expiringWithinThreeDays: [{ name: 'Pedro Reyes', endsOn: asCivilDate('2026-08-21') }],
    voids: [{ paymentId: 'p1', netCentavos: 9000, reason: 'mis-keyed', byName: 'Ana Cruz' }],
    discounts: [
      { paymentId: 'p2', discountType: 'SENIOR', discountCentavos: 14286, byName: 'Ana Cruz' },
    ],
    freezes: [
      {
        membershipId: 'm1',
        name: 'Luis Tan',
        startsOn: asCivilDate('2026-08-20'),
        endsOn: asCivilDate('2026-09-02'),
        byName: 'Owner',
      },
    ],
    graceAdmissions: 0,
    paymentsWithoutReceiptNo: 2,
    gcashUnverified: 0,
    membersNotSeenIn30Days: null,
  };
}

describe('LoggingSummaryTransport', () => {
  it('emits the whole payload as ONE structured line, so a swap to email changes nothing else', async () => {
    const transport = new LoggingSummaryTransport();
    const log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);

    await transport.send(payload());

    expect(log).toHaveBeenCalledTimes(1);
    const line = log.mock.calls[0][0] as string;
    expect(JSON.parse(line)).toMatchObject({
      businessDate: '2026-08-19',
      cash: { varianceCentavos: -1000, countedByName: 'Ana Cruz' },
      gcash: { count: 3, totalCentavos: 240000 },
      membersNotSeenIn30Days: null,
    });
    expect(line).not.toContain('₱');

    log.mockRestore();
  });
});
