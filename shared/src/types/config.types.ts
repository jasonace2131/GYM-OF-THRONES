/**
 * `GET /config` — route 1. What the gym is willing to tell the world.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS A STRICT SUBSET OF `GymConfig`, AND THE OMISSIONS ARE THE POINT.
 *
 * The route is `@Public()`, so every field here is readable by anyone who
 * fetches the URL — no account, no token. `GymConfig` (server-side) additionally
 * carries the anti-abuse thresholds: `stationFanoutSoftLimit`,
 * `stationOffsiteSoftLimit`, `checkinMaxVisitsPerDay`,
 * `checkinStaleVisitHours`, `checkinOfflineMaxAgeHours`. Publishing those
 * would hand anyone attempting a relayed check-in the exact number of
 * submissions that raises a chip on the desk feed — which is the difference
 * between a soft signal and a documented ceiling to stay under.
 *
 * `idempotencyRetentionHours`, `schedulerEnabled` and the station-token batch
 * geometry are omitted for the same reason: operational detail no member's
 * browser needs, and each one is a free hint.
 *
 * The test for adding a field is not "would the portal find it useful" but
 * "would the gym print it on a poster in the lobby".
 * ═══════════════════════════════════════════════════════════════════════════
 */
export interface PublicGymConfig {
  /** IANA. Every date the portal renders is formatted against it. */
  timeZone: string;
  /** `HH:mm`, 24-hour, gym-local. */
  openTime: string;
  closeTime: string;

  /** Days a lapsed term still admits. Members are told this. */
  graceDays: number;
  /** How far ahead the portal warns about renewal. */
  expiringSoonDays: number;

  freezeMinDays: number;
  freezeMaxDays: number;
  freezeAnnualCapDays: number;
  freezeFeeCentavos: number;

  /**
   * Drives the displayed statutory discount: a VAT-registered seller nets out
   * the 12% before applying the 20%. Public because it changes the price a
   * senior or PWD member is quoted, and quoting it wrong is the offence.
   */
  vatRegistered: boolean;

  /**
   * How to pay. `null` when unconfigured — NEVER a placeholder number.
   *
   * A plausible-looking wrong GCash number on a payment screen sends a
   * member's money to a stranger. Absent is recoverable; wrong is not.
   */
  payment: {
    gcashNumber: string | null;
    gcashName: string | null;
  };
}
