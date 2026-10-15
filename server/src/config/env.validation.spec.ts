import { ConfigService } from '@nestjs/config';
import { envValidationSchema, type Env } from './env.validation';
import { GymConfigService } from './gym.config';

/**
 * A minimal environment that parses. Every value here is a throwaway local
 * placeholder — no real credential, connection string or secret appears in
 * this repository, and none may be added to this fixture.
 */
const BASE: Record<string, string> = {
  DATABASE_URL: 'postgresql://localhost:6543/postgres',
  DIRECT_URL: 'postgresql://localhost:5432/postgres',
  SUPABASE_URL: 'https://example.supabase.co',
  STATION_TOKEN_SECRET: 'x'.repeat(32),
  STATION_CREDENTIAL_PEPPER: 'y'.repeat(32),
  IP_HASH_PEPPER: 'z'.repeat(32),
};

function parse(overrides: Record<string, string> = {}): Env {
  return envValidationSchema({ ...BASE, ...overrides });
}

describe('envValidationSchema', () => {
  it('applies every documented default', () => {
    const env = parse();

    expect(env.GYM_TIMEZONE).toBe('Asia/Manila');
    expect(env.GYM_OPEN_TIME).toBe('05:00');
    expect(env.GYM_CLOSE_TIME).toBe('22:00');
    expect(env.MEMBERSHIP_GRACE_DAYS).toBe(3);
    expect(env.MEMBERSHIP_EXPIRING_SOON_DAYS).toBe(7);
    expect(env.MEMBERSHIP_FREEZE_MIN_DAYS).toBe(7);
    expect(env.MEMBERSHIP_FREEZE_MAX_DAYS).toBe(90);
    expect(env.MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS).toBe(90);
    expect(env.STATION_TOKEN_SLOT_SECONDS).toBe(30);
    expect(env.STATION_TOKEN_BATCH_SIZE).toBe(10);
    expect(env.CHECKIN_MIN_SESSION_MINUTES).toBe(20);
    expect(env.IDEMPOTENCY_RETENTION_HOURS).toBe(24);
    expect(env.SCHEDULER_ENABLED).toBe(true);
    expect(env.MEMBERSHIP_GRACE_ADMISSIONS_MAX).toBe(3);
    expect(env.MEMBERSHIP_FREEZE_FEE_CENTAVOS).toBe(10000);
    expect(env.SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS).toBe(20000);
    expect(env.GYM_VAT_REGISTERED).toBe(false);
  });

  it('crashes when a required secret is missing', () => {
    const { STATION_TOKEN_SECRET: _omitted, ...withoutSecret } = BASE;
    expect(() => envValidationSchema(withoutSecret)).toThrow(/STATION_TOKEN_SECRET/);
  });

  it('rejects a secret shorter than 32 characters', () => {
    expect(() => parse({ STATION_CREDENTIAL_PEPPER: 'tooshort' })).toThrow(
      /STATION_CREDENTIAL_PEPPER/,
    );
  });

  describe('GYM_TIMEZONE', () => {
    it('accepts a valid IANA alias that supportedValuesOf would reject', () => {
      expect(parse({ GYM_TIMEZONE: 'Asia/Calcutta' }).GYM_TIMEZONE).toBe('Asia/Calcutta');
    });

    it('rejects a plausible typo a regex would let through', () => {
      expect(() => parse({ GYM_TIMEZONE: 'Asia/Manilla' })).toThrow(/GYM_TIMEZONE/);
    });
  });

  describe('gym hours', () => {
    it.each(['05:00', '00:00', '23:59', '22:00'])('accepts %s', (value) => {
      expect(parse({ GYM_OPEN_TIME: value }).GYM_OPEN_TIME).toBe(value);
    });

    it.each(['5:00', '24:00', '22:60', '2200', '22:00:00', ''])('rejects %p', (value) => {
      expect(() => parse({ GYM_CLOSE_TIME: value })).toThrow(/GYM_CLOSE_TIME/);
    });
  });

  describe('integer ranges', () => {
    it('accepts the bounds of MEMBERSHIP_GRACE_DAYS', () => {
      expect(parse({ MEMBERSHIP_GRACE_DAYS: '0' }).MEMBERSHIP_GRACE_DAYS).toBe(0);
      expect(parse({ MEMBERSHIP_GRACE_DAYS: '14' }).MEMBERSHIP_GRACE_DAYS).toBe(14);
    });

    it('rejects MEMBERSHIP_GRACE_DAYS above 14', () => {
      expect(() => parse({ MEMBERSHIP_GRACE_DAYS: '15' })).toThrow(/MEMBERSHIP_GRACE_DAYS/);
    });

    it('rejects a non-integer', () => {
      expect(() => parse({ STATION_TOKEN_BATCH_SIZE: '10.5' })).toThrow(/STATION_TOKEN_BATCH_SIZE/);
    });

    it('rejects a station-token slot outside 15..120', () => {
      expect(() => parse({ STATION_TOKEN_SLOT_SECONDS: '10' })).toThrow(
        /STATION_TOKEN_SLOT_SECONDS/,
      );
      expect(() => parse({ STATION_TOKEN_SLOT_SECONDS: '121' })).toThrow(
        /STATION_TOKEN_SLOT_SECONDS/,
      );
      expect(parse({ STATION_TOKEN_SLOT_SECONDS: '120' }).STATION_TOKEN_SLOT_SECONDS).toBe(120);
    });

    it('rejects IDEMPOTENCY_RETENTION_HOURS outside 1..168', () => {
      expect(() => parse({ IDEMPOTENCY_RETENTION_HOURS: '0' })).toThrow(
        /IDEMPOTENCY_RETENTION_HOURS/,
      );
      expect(() => parse({ IDEMPOTENCY_RETENTION_HOURS: '169' })).toThrow(
        /IDEMPOTENCY_RETENTION_HOURS/,
      );
    });
  });

  describe('freeze window ordering', () => {
    it('rejects a maximum below the minimum', () => {
      expect(() =>
        parse({ MEMBERSHIP_FREEZE_MIN_DAYS: '30', MEMBERSHIP_FREEZE_MAX_DAYS: '14' }),
      ).toThrow(/MEMBERSHIP_FREEZE_MAX_DAYS/);
    });

    it('rejects an annual cap below the maximum', () => {
      expect(() =>
        parse({ MEMBERSHIP_FREEZE_MAX_DAYS: '90', MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS: '30' }),
      ).toThrow(/MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS/);
    });

    it('accepts equal bounds', () => {
      const env = parse({
        MEMBERSHIP_FREEZE_MIN_DAYS: '30',
        MEMBERSHIP_FREEZE_MAX_DAYS: '30',
        MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS: '30',
      });
      expect(env.MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS).toBe(30);
    });
  });

  describe('SCHEDULER_ENABLED', () => {
    it("parses the STRING 'false' to boolean false", () => {
      // z.coerce.boolean() maps "false" to true. That would run every nightly
      // job on every instance, which is why this is a z.enum + transform.
      expect(parse({ SCHEDULER_ENABLED: 'false' }).SCHEDULER_ENABLED).toBe(false);
    });

    it("parses 'true' to boolean true", () => {
      expect(parse({ SCHEDULER_ENABLED: 'true' }).SCHEDULER_ENABLED).toBe(true);
    });

    it('rejects anything else', () => {
      expect(() => parse({ SCHEDULER_ENABLED: 'yes' })).toThrow(/SCHEDULER_ENABLED/);
    });
  });

  describe('LOGIN_CODE_REQUIRED', () => {
    it('defaults to true — the emailed code is on unless someone turns it off', () => {
      expect(parse().LOGIN_CODE_REQUIRED).toBe(true);
    });

    it("parses the STRING 'false' to boolean false (the kill switch)", () => {
      expect(parse({ LOGIN_CODE_REQUIRED: 'false' }).LOGIN_CODE_REQUIRED).toBe(false);
    });

    it("parses 'true' to boolean true", () => {
      expect(parse({ LOGIN_CODE_REQUIRED: 'true' }).LOGIN_CODE_REQUIRED).toBe(true);
    });

    it('rejects anything else rather than guessing', () => {
      expect(() => parse({ LOGIN_CODE_REQUIRED: '0' })).toThrow(/LOGIN_CODE_REQUIRED/);
    });
  });

  describe('chunk 1 operating parameters', () => {
    it('accepts the bounds of MEMBERSHIP_GRACE_ADMISSIONS_MAX', () => {
      expect(parse({ MEMBERSHIP_GRACE_ADMISSIONS_MAX: '0' }).MEMBERSHIP_GRACE_ADMISSIONS_MAX).toBe(
        0,
      );
      expect(parse({ MEMBERSHIP_GRACE_ADMISSIONS_MAX: '14' }).MEMBERSHIP_GRACE_ADMISSIONS_MAX).toBe(
        14,
      );
    });

    it('rejects MEMBERSHIP_GRACE_ADMISSIONS_MAX above 14', () => {
      expect(() => parse({ MEMBERSHIP_GRACE_ADMISSIONS_MAX: '15' })).toThrow(
        /MEMBERSHIP_GRACE_ADMISSIONS_MAX/,
      );
    });

    it('rejects a freeze fee outside 0..100000 centavos', () => {
      expect(() => parse({ MEMBERSHIP_FREEZE_FEE_CENTAVOS: '-1' })).toThrow(
        /MEMBERSHIP_FREEZE_FEE_CENTAVOS/,
      );
      expect(() => parse({ MEMBERSHIP_FREEZE_FEE_CENTAVOS: '100001' })).toThrow(
        /MEMBERSHIP_FREEZE_FEE_CENTAVOS/,
      );
      expect(parse({ MEMBERSHIP_FREEZE_FEE_CENTAVOS: '0' }).MEMBERSHIP_FREEZE_FEE_CENTAVOS).toBe(0);
    });

    it('rejects a negative variance threshold', () => {
      expect(() => parse({ SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS: '-1' })).toThrow(
        /SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS/,
      );
    });

    it("parses GYM_VAT_REGISTERED as the STRING 'true'/'false', never z.coerce.boolean", () => {
      expect(parse({ GYM_VAT_REGISTERED: 'true' }).GYM_VAT_REGISTERED).toBe(true);
      expect(parse({ GYM_VAT_REGISTERED: 'false' }).GYM_VAT_REGISTERED).toBe(false);
      expect(() => parse({ GYM_VAT_REGISTERED: '1' })).toThrow(/GYM_VAT_REGISTERED/);
    });
  });
});

describe('GymConfigService', () => {
  function serviceFor(overrides: Record<string, string> = {}): GymConfigService {
    const env = parse(overrides);
    const config = {
      get: <K extends keyof Env>(key: K): Env[K] => env[key],
    } as unknown as ConfigService<Env, true>;
    return new GymConfigService(config);
  }

  it('exposes every gym setting in typed form', () => {
    const gym = serviceFor();

    expect(gym.timeZone).toBe('Asia/Manila');
    expect(gym.openTime).toBe('05:00');
    expect(gym.closeTime).toBe('22:00');
    expect(gym.graceDays).toBe(3);
    expect(gym.expiringSoonDays).toBe(7);
    expect(gym.freezeMinDays).toBe(7);
    expect(gym.freezeMaxDays).toBe(90);
    expect(gym.freezeAnnualCapDays).toBe(90);
    expect(gym.stationTokenSlotSeconds).toBe(30);
    expect(gym.stationTokenBatchSize).toBe(10);
    expect(gym.checkinMinSessionMinutes).toBe(20);
    expect(gym.idempotencyRetentionHours).toBe(24);
    expect(gym.schedulerEnabled).toBe(true);
    expect(gym.graceAdmissionsMax).toBe(3);
    expect(gym.freezeFeeCentavos).toBe(10000);
    expect(gym.shiftVarianceNoteThresholdCentavos).toBe(20000);
    expect(gym.vatRegistered).toBe(false);
  });

  it('exposes no secret', () => {
    const gym = serviceFor();
    const serialised = JSON.stringify({ ...gym });

    expect(serialised).not.toContain('x'.repeat(32));
    expect(serialised).not.toContain('y'.repeat(32));
    expect(Object.keys({ ...gym }).join(' ')).not.toMatch(/secret|pepper|password|key/i);
  });

  it('reflects a non-default timezone', () => {
    expect(serviceFor({ GYM_TIMEZONE: 'Asia/Calcutta' }).timeZone).toBe('Asia/Calcutta');
  });
});
