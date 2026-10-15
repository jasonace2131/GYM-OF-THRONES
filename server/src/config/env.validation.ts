import { z } from 'zod';
import { isIanaTimeZone } from '../common/time/gym-time';

/**
 * Validates all required environment variables at startup.
 * The application will crash with a descriptive error if any are missing or
 * invalid. This is intentional — a misconfigured app should never start
 * silently.
 *
 * Adding a variable means adding it in THREE places or the server will not
 * start: this schema, the repository-root .env.example, and the operator's own
 * server/.env (which no agent may read or write).
 */

/** HH:mm on a 24-hour clock. '5:00', '24:00' and '22:60' are all rejected. */
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().min(1).max(65535).default(4000),

    // Pooled connection — used by the app at runtime. Must carry
    // ?pgbouncer=true and an explicit connection_limit, or interactive
    // transactions intermittently fail with "prepared statement s0 already
    // exists", which presents as random 500s rather than as configuration.
    DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
    // Direct (non-pooled) connection — referenced by schema.prisma and required
    // by `prisma migrate`, which cannot run through the transaction pooler.
    DIRECT_URL: z.string().url('DIRECT_URL must be a valid PostgreSQL connection string'),

    // Public. Used to derive the JWT issuer and the JWKS endpoint that access
    // tokens are verified against.
    SUPABASE_URL: z.string().url('SUPABASE_URL must be a valid URL'),
    // Optional on purpose. This key bypasses Row Level Security entirely, and
    // nothing yet needs it — token verification uses the public JWKS.
    SUPABASE_SERVICE_KEY: z.string().min(1).optional(),
    // Where GCash proof screenshots are stored. PRIVATE bucket — every read
    // goes through a short-lived signed URL minted server-side, so an object
    // path leaking is not the same as the image leaking.
    //
    // Defaulted rather than required, and the whole feature warn-and-disables
    // without SUPABASE_SERVICE_KEY, in the same spirit as member creation: the
    // gym must still boot and still sell memberships when storage is
    // unconfigured.
    GCASH_PROOF_BUCKET: z.string().min(1).default('gcash-proofs'),
    CORS_ORIGIN: z.string().default('http://localhost:3000'),

    // ── Gym time ─────────────────────────────────────────────────────────
    // Validated by CONSTRUCTION, never by regex and never by
    // Intl.supportedValuesOf('timeZone'): that returns only canonical names and
    // rejects valid aliases such as Asia/Calcutta, crashing startup on a
    // legitimate value. A regex would pass 'Asia/Manilla' and then format as
    // UTC for the life of the deployment.
    GYM_TIMEZONE: z
      .string()
      .default('Asia/Manila')
      .refine(isIanaTimeZone, { message: 'GYM_TIMEZONE must be a valid IANA time zone' }),
    // Load-bearing, not reporting-only: the station-token endpoint and the
    // STATION_QR check-in path are gated on these hours, so a wrong value
    // refuses real members at the door.
    GYM_OPEN_TIME: z.string().regex(TIME_OF_DAY, 'GYM_OPEN_TIME must be HH:mm').default('05:00'),
    GYM_CLOSE_TIME: z.string().regex(TIME_OF_DAY, 'GYM_CLOSE_TIME must be HH:mm').default('22:00'),

    // ── Membership ───────────────────────────────────────────────────────
    // Default for NEW terms only — snapshotted onto the membership at purchase,
    // so changing it never retroactively re-admits someone already turned away.
    MEMBERSHIP_GRACE_DAYS: z.coerce.number().int().min(0).max(14).default(3),
    MEMBERSHIP_EXPIRING_SOON_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    MEMBERSHIP_FREEZE_MIN_DAYS: z.coerce.number().int().min(1).max(30).default(7),
    MEMBERSHIP_FREEZE_MAX_DAYS: z.coerce.number().int().min(1).default(90),
    MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS: z.coerce.number().int().min(1).default(90),
    // How many times one term may be admitted on grace before the door stops
    // saying yes. Without a ceiling a monthly member trains three free days
    // every cycle, forever.
    MEMBERSHIP_GRACE_ADMISSIONS_MAX: z.coerce.number().int().min(0).max(14).default(3),
    // ₱100. A freeze is pure days-owed liability with zero retention upside in
    // a prepaid cash gym, so it has a visible price — waived when medical.
    MEMBERSHIP_FREEZE_FEE_CENTAVOS: z.coerce.number().int().min(0).max(100000).default(10000),

    // ── Station tokens ───────────────────────────────────────────────────
    // HMACs the display token over stationId ‖ tokenEpoch ‖ slot.
    STATION_TOKEN_SECRET: z.string().min(32, 'STATION_TOKEN_SECRET must be at least 32 characters'),
    // Verify-only, set on a rotation's first deploy so codes already on screen
    // keep working. Dropping it on the second deploy invalidates every
    // outstanding token everywhere within one slot — the global panic button.
    STATION_TOKEN_SECRET_PREVIOUS: z
      .string()
      .min(32, 'STATION_TOKEN_SECRET_PREVIOUS must be at least 32 characters')
      .optional(),
    // 30, not 60: neither endpoint needs offline slack, and it halves the value
    // of a photographed screen.
    STATION_TOKEN_SLOT_SECONDS: z.coerce.number().int().min(15).max(120).default(30),
    // Ten slots is five minutes of DISPLAY runway, not five minutes of admissions.
    STATION_TOKEN_BATCH_SIZE: z.coerce.number().int().min(2).max(20).default(10),
    // Peppers a StationCredential secret before hashing. Never logged, never returned.
    STATION_CREDENTIAL_PEPPER: z
      .string()
      .min(32, 'STATION_CREDENTIAL_PEPPER must be at least 32 characters'),
    // Peppers a request IP before hashing into CheckIn.originIpHash. A raw IP
    // is personal data under the Data Privacy Act and clustering only needs
    // equality, so the raw value is never stored (§6.11.2).
    IP_HASH_PEPPER: z.string().min(32, 'IP_HASH_PEPPER must be at least 32 characters'),
    // Comma-separated CIDRs for the gym's own egress. EMPTY IS LEGAL and means
    // "every request looks off-site", which degrades the signal to noise rather
    // than denying anyone — the origin signal denies nobody by construction.
    GYM_EGRESS_CIDRS: z.string().default(''),

    // ── Attendance and housekeeping ──────────────────────────────────────
    // Below this, a second scan is a no-op rather than a check-out (§6.6.1).
    // It is also the FLOOR of the reopen window below.
    CHECKIN_MIN_SESSION_MINUTES: z.coerce.number().int().min(0).max(120).default(20),
    // Re-entry grace: a scan within this many minutes of the member's OWN
    // QR check-out reopens the same visit — left something at home, stepped
    // out for taho — instead of opening a second visit against the daily
    // ceiling. The effective reopen window is max(this, MIN_SESSION), so 0
    // disables the grace without killing the scanned-by-mistake undo.
    CHECKIN_REENTRY_GRACE_MINUTES: z.coerce.number().int().min(0).max(240).default(60),
    // Above this — or across a business date — a second scan closes the stale
    // visit AND opens a new one. 3, not 4, and the difference is a bug: at 4 a
    // member who trains 06:00-07:30 and returns at 09:30 has their ARRIVAL read
    // as a departure, so the second visit is never recorded (§6.6.1).
    CHECKIN_STALE_VISIT_HOURS: z.coerce.number().int().min(1).max(24).default(3),
    // CLIENT accounts only. Staff who train are exactly the people a low
    // ceiling denies, and a limit whose only realistic victims are legitimate
    // is not a control (§6.5.5).
    CHECKIN_MAX_VISITS_PER_DAY: z.coerce.number().int().min(1).max(20).default(8),
    // Soft anomaly thresholds. They raise a chip on the desk feed and a line on
    // the nightly report; they NEVER deny (§6.11.2).
    STATION_FANOUT_SOFT_LIMIT: z.coerce.number().int().min(2).max(120).default(20),
    STATION_OFFSITE_SOFT_LIMIT: z.coerce.number().int().min(1).max(60).default(5),
    // The DESK's own offline queue (staff-attributed writes only — never the
    // member's; there is no member-side queue at any TTL, §6.10.2).
    CHECKIN_OFFLINE_MAX_AGE_HOURS: z.coerce.number().int().min(1).max(24).default(12),
    IDEMPOTENCY_RETENTION_HOURS: z.coerce.number().int().min(1).max(168).default(24),
    // NOT z.coerce.boolean(), which maps the string "false" to true and would
    // run every nightly job on every instance.
    SCHEDULER_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((value) => value === 'true'),
    // ±₱200. Beyond this the closing staffer must type a note explaining the
    // difference, which is the only thing that makes a blind count useful.
    SHIFT_VARIANCE_NOTE_THRESHOLD_CENTAVOS: z.coerce.number().int().min(0).default(20000),
    // Drives the statutory senior/PWD computation: a VAT-registered seller
    // nets out the 12% before applying the 20% discount. NOT
    // z.coerce.boolean(), which maps the string "false" to true.
    GYM_VAT_REGISTERED: z
      .enum(['true', 'false'])
      .default('false')
      .transform((value) => value === 'true'),

    // How members are told to pay. OPTIONAL, and unset is a supported state:
    // `GET /config` returns null and the portal renders the cash instruction
    // alone rather than a placeholder. A plausible-looking wrong GCash number
    // on a payment screen sends a member's money to a stranger, so "absent" is
    // the only safe default.
    GYM_GCASH_NUMBER: z.string().min(1).optional(),
    GYM_GCASH_NAME: z.string().min(1).optional(),

    // The seller block on the counter Transaction Slip. ALL OPTIONAL, and
    // unset is a supported state: a null line is OMITTED from the slip, never
    // rendered as a placeholder — a plausible-looking wrong TIN on a printed
    // document is worse than an absence. Must match the BIR COR exactly.
    GYM_REGISTERED_NAME: z.string().min(1).optional(),
    GYM_TRADE_NAME: z.string().min(1).optional(),
    GYM_REGISTERED_ADDRESS: z.string().min(1).optional(),
    GYM_TIN: z.string().min(1).optional(),
    // Above this net amount, a GCash sale must carry the staff attestation
    // ("seen in our GCash Transactions tab") or it refuses. OPTIONAL — unset
    // means never required; the checkbox is still always offered.
    GCASH_VERIFY_THRESHOLD_CENTAVOS: z.coerce.number().int().min(0).optional(),

    // The member assistant. OPTIONAL, and unset is a supported state rather
    // than a boot failure: the gym must be able to run without an AI bill, and
    // the rest of the API has no business refusing to start because a chat
    // feature is unconfigured. AssistantService logs a warning and its routes
    // return 503.
    GEMINI_API_KEY: z.string().min(1).optional(),

    // Pins a preferred model to the FRONT of the fallback list rather than
    // replacing it, so tuning the first choice never gives up the fallbacks.
    // Leave unset — the default ordering is measured, not guessed.
    GEMINI_MODEL: z.string().min(1).optional(),

    // Outbound transactional email (Resend), for the member setup link and
    // staff invitations. OPTIONAL, same warn-and-disable spirit as
    // GEMINI_API_KEY: the gym must still boot without an email bill.
    // EmailService logs a warning and `sendMemberJoin` throws;
    // MemberJoinService.issue catches that and answers `emailSent: false`
    // rather than failing the whole request — the member row and their setup
    // link already exist by that point.
    RESEND_API_KEY: z.string().min(1).optional(),
    // The verified "From" address/name Resend sends as. Required alongside
    // RESEND_API_KEY for sending to actually work — see EmailService.
    RESEND_FROM: z.string().min(1).optional(),
    /**
     * Where website enquiries are emailed. Falls back to RESEND_FROM.
     *
     * Separate from the sender because they are usually different addresses:
     * Resend can only send AS a verified domain, but it can send TO anything
     * — including the gym's Gmail.
     */
    CONTACT_NOTIFY_EMAIL: z.string().min(1).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.MEMBERSHIP_FREEZE_MAX_DAYS < env.MEMBERSHIP_FREEZE_MIN_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MEMBERSHIP_FREEZE_MAX_DAYS'],
        message: 'MEMBERSHIP_FREEZE_MAX_DAYS must be at least MEMBERSHIP_FREEZE_MIN_DAYS',
      });
    }
    if (env.MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS < env.MEMBERSHIP_FREEZE_MAX_DAYS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS'],
        message: 'MEMBERSHIP_FREEZE_ANNUAL_CAP_DAYS must be at least MEMBERSHIP_FREEZE_MAX_DAYS',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function envValidationSchema(config: Record<string, unknown>): Env {
  const result = envSchema.safeParse(config);

  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join('.')}: ${issue.message}`)
      .join('\n');

    throw new Error(`Environment validation failed:\n${issues}`);
  }

  return result.data;
}
