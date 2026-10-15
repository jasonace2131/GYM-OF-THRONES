import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from './env.validation';

/**
 * The gym's operating parameters, in one typed shape.
 *
 * Deliberately holds NO secret: STATION_TOKEN_SECRET, its previous value and
 * STATION_CREDENTIAL_PEPPER are read directly by the one service that needs
 * them, so nothing that injects gym settings can accidentally log or serialise
 * a signing key.
 */
export interface GymConfig {
  timeZone: string;
  openTime: string;
  closeTime: string;
  graceDays: number;
  expiringSoonDays: number;
  freezeMinDays: number;
  freezeMaxDays: number;
  freezeAnnualCapDays: number;
  graceAdmissionsMax: number;
  freezeFeeCentavos: number;
  shiftVarianceNoteThresholdCentavos: number;
  vatRegistered: boolean;
  stationTokenSlotSeconds: number;
  stationTokenBatchSize: number;
  checkinMinSessionMinutes: number;
  checkinReentryGraceMinutes: number;
  checkinStaleVisitHours: number;
  checkinMaxVisitsPerDay: number;
  checkinOfflineMaxAgeHours: number;
  stationFanoutSoftLimit: number;
  stationOffsiteSoftLimit: number;
  idempotencyRetentionHours: number;
  schedulerEnabled: boolean;
  gcashNumber: string | null;
  gcashName: string | null;
  registeredName: string | null;
  tradeName: string | null;
  registeredAddress: string | null;
  tin: string | null;
  gcashVerifyThresholdCentavos: number | null;
}

/**
 * The one read path for gym settings.
 *
 * Injected rather than read from process.env at call sites, so a unit test can
 * hand a service a different closing time without mutating global state — the
 * same reason gymToday() takes `now` as a parameter.
 */
@Injectable()
export class GymConfigService implements GymConfig {
  readonly timeZone: string;
  readonly openTime: string;
  readonly closeTime: string;
  readonly graceDays: number;
  readonly expiringSoonDays: number;
  readonly freezeMinDays: number;
  readonly freezeMaxDays: number;
  readonly freezeAnnualCapDays: number;
  readonly graceAdmissionsMax: number;
  readonly freezeFeeCentavos: number;
  readonly shiftVarianceNoteThresholdCentavos: number;
  readonly vatRegistered: boolean;
  readonly stationTokenSlotSeconds: number;
  readonly stationTokenBatchSize: number;
  readonly checkinMinSessionMinutes: number;
  readonly checkinReentryGraceMinutes: number;
  readonly checkinStaleVisitHours: number;
  readonly checkinMaxVisitsPerDay: number;
  readonly checkinOfflineMaxAgeHours: number;
  readonly stationFanoutSoftLimit: number;
  readonly stationOffsiteSoftLimit: number;
  readonly idempotencyRetentionHours: number;
  readonly schedulerEnabled: boolean;
  readonly gcashNumber: string | null;
  readonly gcashName: string | null;
  readonly registeredName: string | null;
  readonly tradeName: string | null;
  readonly registeredAddress: string | null;
  readonly tin: string | null;
  readonly gcashVerifyThresholdCentavos: number | null;

  constructor(config: ConfigService<Env, true>) {
    this.timeZone = config.get('GYM_TIMEZONE');
    this.openTime = config.get('GYM_OPEN_TIME');
    this.closeTime = config.get('GYM_CLOSE_TIME');
    this.graceDays = config.get('MEMBERSHIP_GRACE_DAYS');
    this.expiringSoonDays = config.get('MEMBERSHIP_EXPIRING_SOON_DAYS');
    this.freezeMinDays = config.get('MEMBERSHIP_FREEZE_MIN_DAYS');
    this.freezeMaxDays = config.get('MEMBERSHIP_FREEZE_MAX_DAYS');
    this.freezeAnnualCapDays = config.get('MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS');
    this.graceAdmissionsMax = config.get('MEMBERSHIP_GRACE_ADMISSIONS_MAX');
    this.freezeFeeCentavos = config.get('MEMBERSHIP_FREEZE_FEE_CENTAVOS');
    this.shiftVarianceNoteThresholdCentavos = config.get('SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS');
    this.vatRegistered = config.get('GYM_VAT_REGISTERED');
    this.stationTokenSlotSeconds = config.get('STATION_TOKEN_SLOT_SECONDS');
    this.stationTokenBatchSize = config.get('STATION_TOKEN_BATCH_SIZE');
    this.checkinMinSessionMinutes = config.get('CHECKIN_MIN_SESSION_MINUTES');
    this.checkinReentryGraceMinutes = config.get('CHECKIN_REENTRY_GRACE_MINUTES');
    this.checkinStaleVisitHours = config.get('CHECKIN_STALE_VISIT_HOURS');
    this.checkinMaxVisitsPerDay = config.get('CHECKIN_MAX_VISITS_PER_DAY');
    this.checkinOfflineMaxAgeHours = config.get('CHECKIN_OFFLINE_MAX_AGE_HOURS');
    this.stationFanoutSoftLimit = config.get('STATION_FANOUT_SOFT_LIMIT');
    this.stationOffsiteSoftLimit = config.get('STATION_OFFSITE_SOFT_LIMIT');
    this.idempotencyRetentionHours = config.get('IDEMPOTENCY_RETENTION_HOURS');
    this.schedulerEnabled = config.get('SCHEDULER_ENABLED');
    // `?? null` rather than leaving it undefined: the presenter returns this
    // straight to a JSON response, and `undefined` would drop the key entirely
    // rather than saying "not configured".
    this.gcashNumber = config.get('GYM_GCASH_NUMBER', { infer: true }) ?? null;
    this.gcashName = config.get('GYM_GCASH_NAME', { infer: true }) ?? null;
    // Seller identity for the Transaction Slip — NOT on the public config
    // route; it travels only on ReceiptDoc behind payment.read.
    this.registeredName = config.get('GYM_REGISTERED_NAME', { infer: true }) ?? null;
    this.tradeName = config.get('GYM_TRADE_NAME', { infer: true }) ?? null;
    this.registeredAddress = config.get('GYM_REGISTERED_ADDRESS', { infer: true }) ?? null;
    this.tin = config.get('GYM_TIN', { infer: true }) ?? null;
    this.gcashVerifyThresholdCentavos =
      config.get('GCASH_VERIFY_THRESHOLD_CENTAVOS', { infer: true }) ?? null;
  }
}
