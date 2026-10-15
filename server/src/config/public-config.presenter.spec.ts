import { toPublicGymConfig, WITHHELD_FROM_PUBLIC_CONFIG } from './public-config.presenter';
import type { GymConfig } from './gym.config';

const GYM: GymConfig = {
  timeZone: 'Asia/Manila',
  openTime: '05:00',
  closeTime: '22:00',
  graceDays: 3,
  expiringSoonDays: 7,
  freezeMinDays: 7,
  freezeMaxDays: 90,
  freezeAnnualCapDays: 90,
  graceAdmissionsMax: 3,
  freezeFeeCentavos: 10000,
  shiftVarianceNoteThresholdCentavos: 20000,
  vatRegistered: false,
  stationTokenSlotSeconds: 30,
  stationTokenBatchSize: 10,
  checkinMinSessionMinutes: 20,
  checkinReentryGraceMinutes: 60,
  checkinStaleVisitHours: 3,
  checkinMaxVisitsPerDay: 8,
  checkinOfflineMaxAgeHours: 12,
  stationFanoutSoftLimit: 20,
  stationOffsiteSoftLimit: 5,
  idempotencyRetentionHours: 24,
  schedulerEnabled: true,
  gcashNumber: '0917 000 0000',
  gcashName: 'Gym of Thrones',
  registeredName: 'GOT Fitness OPC',
  tradeName: 'Gym of Thrones',
  registeredAddress: '4th Floor, JWMGI Building, Taguig City 1630',
  tin: '987-654-321-00000',
  gcashVerifyThresholdCentavos: 100000,
};

describe('toPublicGymConfig', () => {
  it('publishes what a member needs to read a price or plan a visit', () => {
    expect(toPublicGymConfig(GYM)).toEqual({
      timeZone: 'Asia/Manila',
      openTime: '05:00',
      closeTime: '22:00',
      graceDays: 3,
      expiringSoonDays: 7,
      freezeMinDays: 7,
      freezeMaxDays: 90,
      freezeAnnualCapDays: 90,
      freezeFeeCentavos: 10000,
      vatRegistered: false,
      payment: { gcashNumber: '0917 000 0000', gcashName: 'Gym of Thrones' },
    });
  });

  /**
   * THE LOAD-BEARING TEST.
   *
   * This route is `@Public()`. Publishing `stationOffsiteSoftLimit` or
   * `checkinMaxVisitsPerDay` would tell anyone attempting a relayed check-in
   * exactly how many submissions raise a chip on the desk feed — turning a
   * soft anomaly signal into a documented ceiling to stay under.
   *
   * Asserted by SERIALISING the whole payload and searching it, so a threshold
   * nested inside a future sub-object cannot slip through a key-only check.
   */
  it.each(WITHHELD_FROM_PUBLIC_CONFIG)('never discloses %s', (key) => {
    // Each withheld setting gets a unique, improbable value, so "this number
    // is absent" cannot be satisfied by coincidence — with the real fixture,
    // `graceAdmissionsMax: 3` and `graceDays: 3` share the string "3" and the
    // assertion would flag a disclosure that never happened.
    const marked: GymConfig = { ...GYM };
    const sentinels = new Map<string, number>();
    WITHHELD_FROM_PUBLIC_CONFIG.forEach((withheld, index) => {
      const sentinel = 900_001 + index;
      sentinels.set(withheld, sentinel);
      (marked as unknown as Record<string, unknown>)[withheld] =
        typeof GYM[withheld] === 'boolean' ? Boolean(sentinel) : sentinel;
    });

    const published = JSON.stringify(toPublicGymConfig(marked));
    expect(published).not.toContain(key);
    expect(published).not.toContain(String(sentinels.get(key)));
  });

  it('reports unconfigured payment details as null, never as a placeholder', () => {
    // A plausible-looking wrong GCash number sends a member's money to a
    // stranger. Absent is recoverable; wrong is not.
    const result = toPublicGymConfig({ ...GYM, gcashNumber: null, gcashName: null });
    expect(result.payment).toEqual({ gcashNumber: null, gcashName: null });
  });
});
