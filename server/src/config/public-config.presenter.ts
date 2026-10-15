import type { PublicGymConfig } from '@got/shared';
import type { GymConfig } from './gym.config';

/**
 * Projects the gym's settings onto the public payload for route 1.
 *
 * PURE, and an explicit field list rather than a spread or an omit-list. A
 * spread would publish every future setting by default and a deny-list would
 * publish anything somebody forgot to add to it — both fail open, and this
 * response is readable by anyone on the internet.
 *
 * Adding a field here is a decision to publish it. See `PublicGymConfig` for
 * what is deliberately withheld and why.
 */
export function toPublicGymConfig(gym: GymConfig): PublicGymConfig {
  return {
    timeZone: gym.timeZone,
    openTime: gym.openTime,
    closeTime: gym.closeTime,
    graceDays: gym.graceDays,
    expiringSoonDays: gym.expiringSoonDays,
    freezeMinDays: gym.freezeMinDays,
    freezeMaxDays: gym.freezeMaxDays,
    freezeAnnualCapDays: gym.freezeAnnualCapDays,
    freezeFeeCentavos: gym.freezeFeeCentavos,
    vatRegistered: gym.vatRegistered,
    payment: {
      gcashNumber: gym.gcashNumber,
      gcashName: gym.gcashName,
    },
  };
}

/**
 * The settings that must NEVER appear in the public payload.
 *
 * Exported so the test asserts against one list rather than restating it, and
 * so adding a threshold to `GymConfig` without thinking about disclosure fails
 * a test rather than shipping.
 */
export const WITHHELD_FROM_PUBLIC_CONFIG = [
  'stationFanoutSoftLimit',
  'stationOffsiteSoftLimit',
  'checkinMaxVisitsPerDay',
  'checkinStaleVisitHours',
  'checkinOfflineMaxAgeHours',
  'checkinMinSessionMinutes',
  // The member sees the window on their own goodbye card, where it has
  // context; a bare number on a public route is just relay reconnaissance.
  'checkinReentryGraceMinutes',
  'stationTokenSlotSeconds',
  'stationTokenBatchSize',
  'idempotencyRetentionHours',
  'schedulerEnabled',
  'shiftVarianceNoteThresholdCentavos',
  'graceAdmissionsMax',
  // Seller identity for the printed Transaction Slip. A TIN and a registered
  // address on a @Public() route is gratuitous disclosure — these travel only
  // on ReceiptDoc, behind payment.read.
  'registeredName',
  'tradeName',
  'registeredAddress',
  'tin',
  'gcashVerifyThresholdCentavos',
] as const satisfies readonly (keyof GymConfig)[];
