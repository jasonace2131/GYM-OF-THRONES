import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type AccessVerdict as PrismaAccessVerdict,
  type CheckIn,
  type CheckInMethod as PrismaCheckInMethod,
  type DenialReason as PrismaDenialReason,
  type Role,
} from '@prisma/client';
import {
  AccessVerdict,
  DenialReason,
  type CheckInMembershipSummary,
  type CheckInOutcome,
  type CheckInResult,
  type CheckInStatus,
  type DeskFeedEvent,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import type { Env } from '../config/env.validation';
import { DomainException } from '../common/exceptions/domain.exception';
import {
  civilDateFromPrisma,
  gymToday,
  toDateColumn,
  type CivilDate,
} from '../common/time/gym-time';
import { accessVerdict, type AccessResult, type AccessSubject } from '../membership/access-verdict';
import { MembershipService } from '../membership/membership.service';
import type { AuthUser } from '../auth/auth.types';
import { StationTokenService } from './station-token.service';
import { DeskFeedService } from './desk-feed.service';
import { isWithinGymHours, type GymHours } from './gym-hours';
import { OpeningHoursService } from '../config/opening-hours.service';
import { hashIp, isOffSiteOrigin, parseCidrList, type CidrRange } from './origin';
import {
  presentCheckIn,
  toCheckInMembershipSummary,
  type CheckInPresentation,
} from './check-in.presenter';
import { toDeskMember } from '../front-desk/desk.presenter';

/**
 * `POST /api/v1/checkin` — a member scans the counter QR with their own phone.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SIX PROPERTIES THIS FILE'S SHAPE DEPENDS ON. Each has bitten someone.
 *
 * 1. EVERY INSERT THAT CAN HIT A UNIQUE INDEX USES
 *    `createMany({ skipDuplicates: true })`, NEVER A CAUGHT `P2002`.
 *    Postgres aborts the transaction on the first statement error and Prisma
 *    issues no per-statement SAVEPOINT, so catching a unique violation and
 *    then querying the same `tx` dies with `25P02` — the replay-detection path
 *    in the naive implementation is dead code that 500s at exactly the
 *    double-tap it was written to handle. This applies to the `StationScan`
 *    claim AND to the `CheckIn` insert. The second is not theoretical: two
 *    devices on one account presenting DIFFERENT slots do not collide on
 *    `StationScan` at all, both reach the admit path, and both insert a
 *    `CheckIn` with the same `openUserId`.
 *
 * 2. THE VERDICT IS RE-EVALUATED INSIDE THE TRANSACTION. Verdict-then-write
 *    across two round trips is a TOCTOU window a concurrent cancel or freeze
 *    walks straight through. `loadSubjectAndRow` is handed `tx`, not the
 *    pooled client, and that is the whole of the fix.
 *
 * 3. EVERY CLOSE AND EVERY REOPEN IS A CONDITIONAL `updateMany`, guarded on
 *    `endedAt IS NULL AND voidedAt IS NULL` (close) or `endedAt IS NOT NULL
 *    AND voidedAt IS NULL AND openUserId IS NULL` (reopen). Two requests
 *    racing produce exactly one winner; the loser sees `count === 0` and falls
 *    through, where `skipDuplicates` turns the collision into
 *    `ALREADY_INSIDE`.
 *
 * 4. `accessVerdict()` IS CALLED WITH `AccessSubject` EXACTLY AS §5.4.1
 *    DEFINES IT. It takes no station, no method, no origin and no `via` field,
 *    and none may be added: the door ladder answers "may this person train
 *    today", which has nothing to do with how they arrived. No caller
 *    collapses the three-valued decision to a boolean.
 *
 * 5. `dayPassValidToday` IS A NON-VOIDED `WALK_IN` `CheckIn` ON TODAY'S
 *    GYM-LOCAL BUSINESS DATE. There is no `DayPass` model, there never was,
 *    and none is introduced here — the name is a §5 artifact and §5 is final.
 *
 * 6. BUSINESS DATES ARE COMPARED AS `CivilDate` STRINGS END TO END. A
 *    `@db.Date` column comes back from Prisma as a JS `Date` at UTC MIDNIGHT;
 *    comparing that against a gym-local civil date is wrong for every visit
 *    before 08:00 Manila — and the gym opens at 05:00, which is exactly the
 *    band the stale-visit rule branches on. `businessDate` is read through
 *    `civilDateFromPrisma` and compared with `===`, never as a `Date`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * TWO RULINGS this file records rather than leaves to be rediscovered.
 *
 * A. `Idempotency-Key` IS EXEMPT ON THIS ROUTE. `StationScan
 *    @@unique([userId, stationId, slot])` IS this route's idempotency key and
 *    is strictly stronger — it also catches two devices signed into one
 *    account presenting the same code. `client/src/lib/api.ts` injects the
 *    header on every POST; it is ignored here. Honouring both would give two
 *    idempotency mechanisms that can disagree, which is worse than either
 *    alone. There is therefore no `@Idempotent()` on the controller.
 *
 * B. AN ADMISSION EARNED ONLY BY `DAY_PASS_VALID` REOPENS TODAY'S WALK-IN
 *    VISIT; it never opens a new row. `CheckIn_entry_shape` is biconditional:
 *    a `MEMBERSHIP` row REQUIRES a `membershipId`, and a `WALK_IN` row
 *    REQUIRES a `paymentId` — so a member re-entering on a day pass they
 *    already bought fits neither, and inventing a third entry type would be a
 *    second answer to "did this person pay for today". Reopening is both the
 *    honest model (one paid day is one visit) and the only shape the schema
 *    can hold. See `admitOnDayPass` below.
 */
@Injectable()
export class CheckInService {
  private readonly logger = new Logger(CheckInService.name);
  private readonly gymEgress: CidrRange[];
  private readonly ipPepper: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService<Env, true>,
    private readonly gym: GymConfigService,
    private readonly tokens: StationTokenService,
    private readonly memberships: MembershipService,
    private readonly deskFeed: DeskFeedService,
    private readonly openingHours: OpeningHoursService,
  ) {
    // Parsed once at construction, not per request: the allowlist is boot-time
    // configuration and re-parsing it on the hot path would put string work on
    // the 06:00 peak for no benefit.
    this.gymEgress = parseCidrList(this.config.get('GYM_EGRESS_CIDRS'));
    this.ipPepper = this.config.get('IP_HASH_PEPPER');
  }

  /**
   * The cached read on the way INTO the scanner (§7.4).
   *
   * It renders "You're checked in since 6:12 PM — scan again when you leave
   * to check out" BEFORE the camera arms. The second scan only OFFERS the
   * check-out; the member confirms it with a button (`confirmCheckOut`).
   */
  async statusFor(user: AuthUser, now: Date = new Date()): Promise<CheckInStatus> {
    const today = gymToday(now, this.gym.timeZone);
    const [open, subject, visitsToday] = await Promise.all([
      this.prisma.checkIn.findUnique({ where: { openUserId: user.id } }),
      this.memberships.loadSubject(user.id, today),
      this.prisma.checkIn.count({
        where: { userId: user.id, businessDate: toDateColumn(today), voidedAt: null },
      }),
    ]);

    const verdict = accessVerdict(subject, today, this.memberships.accessConfig);

    return {
      open:
        open === null
          ? null
          : {
              checkInId: open.id,
              startedAt: open.occurredAt.toISOString(),
            },
      membership: toCheckInMembershipSummary(subject.membership, verdict),
      // A BOOLEAN IS SAFE HERE AND ONLY HERE: this is a pre-flight hint the
      // phone uses to warm up its copy, never a decision. The three-valued
      // decision travels intact on `membership.decision`, and the real
      // verdict is recomputed inside the write transaction regardless.
      wouldAdmit: verdict.decision !== 'DENY',
      visitsToday,
      serverTime: now.toISOString(),
    };
  }

  /**
   * The write path. Returns 200 in every business outcome, including every
   * denial — `client/src/lib/api.ts` throws on `!body.success`, and a thrown
   * denial reaches a member's phone as a bare Error with no reason and no next
   * step.
   */
  async recordStationScan(
    user: AuthUser,
    stationToken: string,
    ip: string | undefined,
    now: Date = new Date(),
  ): Promise<CheckInResult> {
    // ── outside the transaction ───────────────────────────────────────────
    // The pooled Supabase connection must be held for as few statements as
    // possible, and none of this needs to be transactional: verification is
    // pure, and identity cannot meaningfully change inside one request.
    const parsed = this.tokens.parsePayload(stationToken);
    if (parsed === null) {
      throw new DomainException(
        'STATION_TOKEN_MALFORMED',
        'That code is not a Gym of Thrones station code.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const station = await this.prisma.station.findUnique({ where: { code: parsed.stationCode } });
    const outcome = this.tokens.verify({
      payload: stationToken,
      station:
        station === null
          ? null
          : {
              stationId: station.id,
              tokenEpoch: station.tokenEpoch,
              isActive: station.isActive,
            },
      secrets: this.verifySecrets(),
      now,
      slotSeconds: this.gym.stationTokenSlotSeconds,
    });

    if (outcome.kind === 'INVALID') {
      // Unknown station, inactive station, wrong epoch and a forged MAC are
      // ONE response on the wire. `isActive: false` is the "the tablet was
      // stolen" switch, and an endpoint that tells any member which stations
      // are deliberately disabled is reporting the incident to the person who
      // caused it. The real distinction is logged, here and nowhere else.
      this.logger.warn(
        `Station token rejected: code=${parsed.stationCode} ` +
          `known=${station !== null} active=${station?.isActive ?? false}`,
      );
      throw new DomainException(
        'STATION_TOKEN_INVALID',
        'That code was not accepted. Scan the code on the screen.',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (outcome.kind === 'NOT_YET_VALID') {
      // A STATION-CLOCK ALARM, NOT A MEMBER ACTION. After the MAC-before-slot
      // ordering this has exactly one cause: the display's clock is ahead.
      // Nothing is written, and it is loud on purpose.
      this.logger.error(
        `Station ${parsed.stationCode} presented a FUTURE slot (${parsed.slot}) — its clock is drifting.`,
      );
      throw new DomainException(
        'STATION_TOKEN_NOT_YET_VALID',
        'That code is not valid yet. Please see the front desk.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Non-null from here: both remaining outcomes carry a real station.
    const resolved = station!;
    const originIpHash = hashIp(ip, this.ipPepper);
    const offSiteOrigin = isOffSiteOrigin(ip, this.gymEgress);

    // Best-effort and NEVER fatal. A member self-scan must not be blocked on
    // staff having opened the drawer — `CheckIn_shift_shape` only requires a
    // shift when money or a staff action is involved.
    const openShift = await this.prisma.shift.findFirst({
      where: { closedAt: null },
      select: { id: true },
    });

    // Identity for the row and the desk feed, read once, off the transaction
    // budget. None of it can change inside one request.
    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { avatarUrl: true, firstName: true, lastName: true, memberCode: true },
    });

    const preVerdict: PreVerdict =
      outcome.kind === 'EXPIRED'
        ? {
            kind: 'DENY',
            reason: DenialReason.STATION_TOKEN_EXPIRED,
            tokenStalenessSeconds: outcome.tokenStalenessSeconds,
          }
        : await this.gymHoursDenial(now);

    const context: ScanContext = {
      user: { id: user.id, role: user.role },
      profile,
      station: resolved,
      slot: parsed.slot,
      method: 'STATION_QR',
      // NULL, and biconditionally so: nobody recorded a self-scan, and naming
      // a staff member on one puts an innocent operator's id on an entry they
      // never touched.
      recordedById: null,
      originIpHash,
      offSiteOrigin,
      shiftId: openShift?.id ?? null,
      offlineQueued: false,
      now,
      today: gymToday(now, this.gym.timeZone),
      preVerdict,
      // A self-scan can never override anything.
      overriding: null,
    };

    const { result, feed } = await this.prisma.$transaction((tx) => this.runScan(tx, context), {
      timeout: 8_000,
    });

    // ── after commit, never inside ────────────────────────────────────────
    // Publishing inside the transaction would put a denial on the desk that a
    // rollback then erases, and staff would walk towards a member the database
    // says never tried.
    if (feed !== null) this.deskFeed.publish(feed);

    return result;
  }

  /**
   * The DESK's entry point — a staffer recording a member by hand.
   *
   * Runs the SAME write core as the member's own scan: the door ladder, the
   * open-visit rules, the stale close, the reopen window, the daily ceiling
   * and the response composition are all shared. What differs is that there is
   * no slot to claim, no gym-hours gate, and both `recordedById` and `shiftId`
   * are populated — a staff action is always attributable to a named person
   * and a counted drawer.
   *
   * `occurredAt` may be in the past when the desk's own offline queue is
   * flushing; it is validated by the caller and drives the business date, so a
   * buffered entry lands on the day it happened rather than the day it synced.
   */
  async recordDeskEntry(input: {
    subject: EntrySubject;
    profile: ScanProfile;
    method: 'MEMBER_CODE' | 'MANUAL';
    recordedById: string;
    shiftId: string;
    offlineQueued: boolean;
    occurredAt: Date;
    /** Set only by the override route — the denial reason being overridden. */
    overriding?: PrismaDenialReason;
  }): Promise<CheckInResult> {
    const context: ScanContext = {
      user: input.subject,
      profile: input.profile,
      // No station and no slot: that is what makes this a desk entry, and
      // `CheckIn_station_shape` is biconditional so the row could not carry
      // one even by mistake.
      station: null,
      slot: null,
      method: input.method,
      recordedById: input.recordedById,
      // NOT the desk's IP. The relay signal is about the MEMBER's own device;
      // stamping the counter's address on every manual entry would fill that
      // column with the gym's own address and dilute the one signal a live
      // relay cannot evade.
      originIpHash: null,
      offSiteOrigin: false,
      shiftId: input.shiftId,
      offlineQueued: input.offlineQueued,
      now: input.occurredAt,
      // Derived from `occurredAt`, NOT from the clock: a queued entry belongs
      // to the business date it happened on.
      today: gymToday(input.occurredAt, this.gym.timeZone),
      // THE GYM-HOURS GATE NEVER APPLIES HERE. An early opening, a public
      // holiday or a timezone typo must not leave staff standing at the desk
      // with a member in front of them, unable to record anything.
      preVerdict: { kind: 'PROCEED' },
      overriding: input.overriding ?? null,
    };

    const { result, feed } = await this.prisma.$transaction((tx) => this.runScan(tx, context), {
      timeout: 8_000,
    });

    if (feed !== null) this.deskFeed.publish(feed);
    return result;
  }

  /**
   * `POST /api/v1/checkin/checkout` — the member taps Check out on the card a
   * second scan showed them (owner, 2026-10-20).
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * PROOF OF PRESENCE IS A RECENT SCAN, NOT THE BUTTON.
   *
   * The button is just a POST with a visit id; anyone signed in can send it
   * from anywhere. What makes it a check-out AT THE GYM is the `StationScan`
   * row the second scan left behind: outcome `ALREADY_INSIDE`, stamped with
   * this visit's id, consumed within `CHECK_OUT_CONFIRM_WINDOW_MS`. Its
   * station and slot become the close's station columns, exactly as if the
   * scan itself had closed the visit — which is also what keeps the re-entry
   * grace working, because `decide()`'s reopen path keys on
   * `closeMethod = 'STATION_QR'`.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * A DOUBLE TAP RETURNS THE SAME CARD. A visit this member closed by QR inside
   * the same window answers with its CHECKED_OUT result again — no write, no
   * second desk-feed event — so a phone that lost the first response does not
   * show an error for a check-out that happened.
   */
  async confirmCheckOut(
    user: AuthUser,
    checkInId: string,
    ip: string | undefined,
    now: Date = new Date(),
  ): Promise<CheckInResult> {
    const windowStart = new Date(now.getTime() - CHECK_OUT_CONFIRM_WINDOW_MS);

    const visit = await this.prisma.checkIn.findUnique({ where: { id: checkInId } });
    // ONE answer for "not yours", "voided" and "no such visit": the route must
    // not be an oracle for which check-in ids exist.
    if (visit === null || visit.userId !== user.id || visit.voidedAt !== null) {
      throw checkOutNotOpen();
    }

    const profile = await this.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
      select: { avatarUrl: true, firstName: true, lastName: true, memberCode: true },
    });

    if (visit.openUserId !== user.id) {
      return this.repeatCheckOut(user, profile, visit, windowStart, now);
    }

    // A reopen draws a line under every scan before it: a proof scan from
    // before a check-out-and-return must not close the resumed visit.
    const lastReopen = await this.prisma.stationScan.findFirst({
      where: { userId: user.id, checkInId: visit.id, outcome: 'REOPENED' },
      orderBy: { consumedAt: 'desc' },
      select: { consumedAt: true },
    });

    const proof = await this.prisma.stationScan.findFirst({
      where: {
        userId: user.id,
        checkInId: visit.id,
        outcome: 'ALREADY_INSIDE',
        consumedAt:
          lastReopen === null
            ? { gte: windowStart }
            : { gte: windowStart, gt: lastReopen.consumedAt },
        // A FRESH code, not merely a recent request. An expired token still
        // verifies (MAC-valid, old slot) and still lands as ALREADY_INSIDE, so
        // the scan's own slot must sit inside the window too — otherwise a
        // photo of Monday's code checks a member out from home on Tuesday.
        // The `- 1` is the verifier's own one-slot look-back.
        slot: {
          gte:
            this.tokens.computeSlot(
              new Date(now.getTime() - CHECK_OUT_CONFIRM_WINDOW_MS),
              this.gym.stationTokenSlotSeconds,
            ) - 1,
        },
        // And the card that scan rendered must actually have offered the
        // check-out: the server's own decision, stored verbatim.
        responseSnapshot: { path: ['checkOutOffered'], equals: true },
      },
      orderBy: { consumedAt: 'desc' },
      select: { slot: true, station: { select: { id: true, code: true, name: true } } },
    });
    if (proof === null) {
      throw new DomainException(
        'CHECK_OUT_SCAN_REQUIRED',
        'Scan the code at the desk again to check out.',
        HttpStatus.FORBIDDEN,
      );
    }

    // Best-effort and never fatal, exactly like the scan path.
    const openShift = await this.prisma.shift.findFirst({
      where: { closedAt: null },
      select: { id: true },
    });

    const context: ScanContext = {
      user: { id: user.id, role: user.role },
      profile,
      // Where the member scanned, not where the button was pressed: the
      // proof scan is the presence, so it is also the close station.
      station: proof.station,
      slot: proof.slot,
      method: 'STATION_QR',
      recordedById: null,
      originIpHash: hashIp(ip, this.ipPepper),
      offSiteOrigin: isOffSiteOrigin(ip, this.gymEgress),
      shiftId: openShift?.id ?? null,
      offlineQueued: false,
      now,
      today: gymToday(now, this.gym.timeZone),
      preVerdict: { kind: 'PROCEED' },
      overriding: null,
    };

    const decided = await this.prisma.$transaction(
      async (tx): Promise<Decided | null> => {
        // Re-read inside the transaction: the visit may have been closed by
        // the desk, the nightly job or a second tap since the read above.
        const open = await tx.checkIn.findUnique({ where: { openUserId: user.id } });
        if (open === null || open.id !== visit.id) return null;
        const closed = await this.closeVisit(tx, context, open, 'STATION_QR');
        if (closed === null) return null;
        // MEMBERSHIP IS NEVER EVALUATED ON THE WAY OUT.
        return this.finish(tx, context, { outcome: 'CHECKED_OUT', checkIn: closed });
      },
      { timeout: 8_000 },
    );

    if (decided === null) {
      // Lost the close race. If the winner was this member's own QR close
      // (the other tap), answer as the double tap; otherwise it is not open.
      const after = await this.prisma.checkIn.findUnique({ where: { id: visit.id } });
      if (after === null || after.voidedAt !== null) throw checkOutNotOpen();
      return this.repeatCheckOut(user, profile, after, windowStart, now);
    }

    // After commit, never inside — same rule as the scan path.
    const { result, feed } = decided.envelope;
    if (feed !== null) this.deskFeed.publish(feed);
    return result;
  }

  /**
   * The double-tap answer: the CHECKED_OUT card for a visit this member closed
   * by QR inside the confirm window, recomposed with no write and no feed
   * event. Anything else that is not open is `CHECK_OUT_NOT_OPEN`.
   */
  private async repeatCheckOut(
    user: AuthUser,
    profile: ScanProfile,
    visit: CheckIn,
    windowStart: Date,
    now: Date,
  ): Promise<CheckInResult> {
    if (
      visit.openUserId !== null ||
      visit.closeMethod !== 'STATION_QR' ||
      visit.endedAt === null ||
      visit.endedAt < windowStart
    ) {
      throw checkOutNotOpen();
    }

    const station =
      visit.closeStationId === null
        ? null
        : await this.prisma.station.findUnique({
            where: { id: visit.closeStationId },
            select: { id: true, code: true, name: true },
          });

    const context: ScanContext = {
      user: { id: user.id, role: user.role },
      profile,
      station,
      slot: visit.closeStationSlot,
      method: 'STATION_QR',
      recordedById: null,
      originIpHash: null,
      offSiteOrigin: visit.closeOffSiteOrigin ?? false,
      shiftId: null,
      offlineQueued: false,
      now,
      today: gymToday(now, this.gym.timeZone),
      preVerdict: { kind: 'PROCEED' },
      overriding: null,
    };

    // `finish` reads nothing for a CHECKED_OUT outcome, so handing it the
    // pooled client writes nothing; the feed event it composes is discarded.
    const decided = await this.finish(this.prisma, context, {
      outcome: 'CHECKED_OUT',
      checkIn: visit,
    });
    return decided.envelope.result;
  }

  // ───────────────────────────────────────────────────────────────────────
  // The transaction
  // ───────────────────────────────────────────────────────────────────────

  private async runScan(
    tx: Prisma.TransactionClient,
    ctx: ScanContext,
  ): Promise<{ result: CheckInResult; feed: DeskFeedEvent | null }> {
    // A DESK ENTRY HAS NO SLOT TO CLAIM. Its replay protection is the
    // ordinary `Idempotency-Key` contract every other staff write uses, plus
    // the `openUserId` sentinel — which is precisely why that sentinel exists
    // as a mechanism separate from StationScan (§6.11.1).
    if (ctx.station === null || ctx.slot === null) {
      return (await this.decide(tx, ctx)).envelope;
    }

    // 1. Claim the slot BEFORE the verdict is computed, so a slot is consumed
    //    by PRESENTATION regardless of outcome.
    const claim = await tx.stationScan.createMany({
      data: [
        {
          userId: ctx.user.id,
          stationId: ctx.station.id,
          slot: ctx.slot,
          originIpHash: ctx.originIpHash,
          offSiteOrigin: ctx.offSiteOrigin,
        },
      ],
      skipDuplicates: true,
    });

    if (claim.count === 0) {
      const replay = await this.replayOf(tx, ctx);
      // A null snapshot means the row exists but its writer has not finished.
      // `INSERT … ON CONFLICT DO NOTHING` BLOCKS on a concurrent inserting
      // transaction and only returns once that transaction ends, so by the
      // time we are here the snapshot is written — unless the writer rolled
      // back, in which case falling through and evaluating afresh is the
      // correct recovery and `openUserId` still bounds the result.
      if (replay !== null) return { result: replay, feed: null };
      this.logger.warn(
        `StationScan (${ctx.user.id}, ${ctx.station.id}, ${ctx.slot}) claimed with no snapshot — re-evaluating.`,
      );
    }

    const decided = await this.decide(tx, ctx);
    await this.stampScan(tx, ctx, decided);
    return decided.envelope;
  }

  /** Steps 2–4: the ladder, the writes, and the rendered body. */
  private async decide(tx: Prisma.TransactionClient, ctx: ScanContext): Promise<Decided> {
    const open = await tx.checkIn.findUnique({ where: { openUserId: ctx.user.id } });

    if (open !== null) {
      const ageMinutes = (ctx.now.getTime() - open.occurredAt.getTime()) / 60_000;
      const stale =
        ageMinutes >= this.gym.checkinStaleVisitHours * 60 ||
        civilDateFromPrisma(open.businessDate) !== ctx.today;

      if (!stale) {
        // A SECOND SCAN NEVER CHECKS ANYONE OUT BY ITSELF (owner, 2026-10-20).
        // It used to close the visit once it was CHECKIN_MIN_SESSION_MINUTES
        // old, which made a confused re-scan a departure and made the feature
        // untestable for twenty minutes. Now it is ALREADY_INSIDE at any age:
        // the slot is consumed, the StationScan row is stamped with this
        // visit's id, and the phone offers a Check out button that calls
        // `confirmCheckOut` — which accepts that stamped scan as its proof of
        // presence for CHECK_OUT_CONFIRM_WINDOW_MS. No CheckIn row is written.
        //
        // A DESK ENTRY lands here too, and gets the same answer: staff close a
        // visit with the explicit checkout on the desk console, never by
        // recording the member a second time.
        return this.finish(tx, ctx, { outcome: 'ALREADY_INSIDE', checkIn: open });
      } else {
        // An open visit older than CHECKIN_STALE_VISIT_HOURS, or carrying an
        // earlier businessDate, is not a live session — it is Monday's visit
        // surviving until Tuesday. Close it as STALE_CLOSE (autoClosed, so it
        // is excluded from every duration statistic exactly like an
        // auto-closed row) and open a NEW visit from the same scan, running
        // the full ladder because they may have expired overnight.
        await this.closeVisit(tx, ctx, open, 'STALE_CLOSE');
        // One scan, correct data, no 30-second wait for the next slot, and no
        // member standing at a desk being told to scan twice. The outcome is
        // RECHECKED_IN rather than CHECKED_IN so the phone (and the desk feed)
        // can say "we closed your old visit and started a new one" instead of
        // silently pretending the first one never happened.
        return this.admit(tx, ctx, 'RECHECKED_IN');
      }
    } else {
      // The reopen window doubles as the RE-ENTRY GRACE: went home for a
      // forgotten towel, scanned out on the way, back within the window —
      // same visit resumed, no second slot against the daily ceiling.
      // Same business date only: a visit closed at 23:55 must not reopen at
      // 00:05 carrying yesterday's businessDate, which the next scan would
      // then read as stale. Cross-midnight returns get a clean new visit.
      const undo = await tx.checkIn.findFirst({
        where: {
          userId: ctx.user.id,
          voidedAt: null,
          openUserId: null,
          closeMethod: 'STATION_QR',
          businessDate: toDateColumn(ctx.today),
          endedAt: { gte: new Date(ctx.now.getTime() - this.reopenWindowMs) },
        },
        orderBy: { endedAt: 'desc' },
      });

      if (undo !== null) {
        // DELIBERATELY NOT RE-RUNNING THE LADDER. A reopen resumes a visit
        // whose admission was already decided, within the same business date;
        // membership transitions land on date boundaries, so the exposure is
        // a same-day staff cancellation — visible on the attendance screen.
        const reopened = await this.reopenVisit(tx, ctx, undo);
        if (reopened !== null) {
          return this.finish(tx, ctx, { outcome: 'REOPENED', checkIn: reopened });
        }
        // Two racers reopening one visit produce one winner; the loser falls
        // through to the admit path, where skipDuplicates turns the collision
        // into ALREADY_INSIDE.
      }
    }

    return this.admit(tx, ctx);
  }

  /**
   * Step 3: the admit path. No open visit, or one just stale-closed.
   *
   * `admittedAs` is `CHECKED_IN` normally and `RECHECKED_IN` when this scan
   * also closed a stale visit — the member arrived, and the row it replaced
   * was Monday's forgotten one, not tonight's session.
   */
  private async admit(
    tx: Prisma.TransactionClient,
    ctx: ScanContext,
    admittedAs: 'CHECKED_IN' | 'RECHECKED_IN' = 'CHECKED_IN',
  ): Promise<Decided> {
    // The ceiling applies to CLIENT accounts ONLY. `checkin.self` widens to
    // COACH, FRONT_DESK and ADMIN at OWN so staff who train can check in, and
    // a coach training between clients across a split shift is exactly the
    // person a low ceiling denies. A limit whose only realistic victims are
    // legitimate is not a control.
    // `overriding` relaxes EXACTLY the gate that produced the denial being
    // overridden — the desk feed offers "Override with a PIN" for the daily
    // ceiling, and before this flag the override re-ran the same ceiling and
    // manufactured a second identical denial while marking the first resolved.
    if (ctx.user.role === 'CLIENT' && ctx.overriding !== 'CHECKIN_DAILY_LIMIT') {
      const visitsToday = await tx.checkIn.count({
        where: { userId: ctx.user.id, businessDate: toDateColumn(ctx.today), voidedAt: null },
      });
      if (visitsToday >= this.gym.checkinMaxVisitsPerDay) {
        return this.denyWithoutMembership(tx, ctx, DenialReason.CHECKIN_DAILY_LIMIT);
      }
    }

    // The pre-verdict denials (an expired token, a closed gym) are decided
    // before the ladder and write a denial row all the same — they are
    // business outcomes the phone must render calmly, not exceptions.
    if (ctx.preVerdict.kind === 'DENY') {
      return this.denyWithoutMembership(
        tx,
        ctx,
        ctx.preVerdict.reason,
        ctx.preVerdict.tokenStalenessSeconds ?? null,
      );
    }

    const loaded = await this.memberships.loadSubjectAndRow(ctx.user.id, ctx.today, tx);
    const verdict = accessVerdict(loaded.subject, ctx.today, this.memberships.accessConfig);

    if (verdict.decision === 'DENY') {
      const denial = await tx.checkInDenial.create({
        data: {
          userId: ctx.user.id,
          reason: verdict.denialReason ?? DenialReason.NO_MEMBERSHIP,
          method: ctx.method,
          occurredAt: ctx.now,
          businessDate: toDateColumn(ctx.today),
          membershipStatusAtTime: loaded.storedStatus,
          stationId: ctx.station?.id ?? null,
          stationSlot: ctx.slot,
          recordedById: ctx.recordedById,
          shiftId: ctx.shiftId,
          originIpHash: ctx.originIpHash,
          offSiteOrigin: ctx.offSiteOrigin,
        },
      });
      return this.finish(tx, ctx, {
        outcome: 'DENIED',
        denial: { id: denial.id, reason: sharedDenialReason(denial.reason) },
        verdict,
        subject: loaded.subject,
      });
    }

    // RULING B: admitted only by a day pass they already bought — reopen that
    // visit rather than manufacture a row no entry type can hold.
    if (verdict.allowReason === 'DAY_PASS_VALID') {
      const reopened = await this.admitOnDayPass(tx, ctx);
      if (reopened !== null) {
        return this.finish(tx, ctx, {
          outcome: reopened.outcome,
          checkIn: reopened.checkIn,
          verdict,
          subject: loaded.subject,
        });
      }
      // The walk-in row was voided or raced away between the ladder's read and
      // this one. Defensive, and honest: without it there is nothing paid for.
      return this.denyWithoutMembership(tx, ctx, DenialReason.NO_MEMBERSHIP, null, loaded.subject);
    }

    if (loaded.membershipId === null) {
      // Unreachable through the ladder: every remaining allow reason is a
      // membership state. Kept because `CheckIn_entry_shape` would otherwise
      // turn a future ladder change into a 500 at the counter rather than a
      // denial the desk can see.
      this.logger.error(
        `Allow reason ${verdict.allowReason ?? 'unknown'} with no membership for user ${ctx.user.id}.`,
      );
      return this.denyWithoutMembership(tx, ctx, DenialReason.NO_MEMBERSHIP, null, loaded.subject);
    }

    const assignment = await tx.coachAssignment.findUnique({
      where: { activeMemberId: ctx.user.id },
      select: { coachId: true },
    });

    const inserted = await tx.checkIn.createMany({
      data: [
        {
          userId: ctx.user.id,
          entryType: 'MEMBERSHIP',
          // GRACE maps to ALLOWED_IN_GRACE and ALLOW to ALLOWED. The
          // three-valued decision is never collapsed to a boolean.
          verdict: verdict.verdict ?? AccessVerdict.ALLOWED,
          membershipId: loaded.membershipId,
          // Snapshot at admission. A later status correction must not rewrite
          // what was true at the door.
          membershipStatusAtTime: loaded.storedStatus,
          occurredAt: ctx.now,
          businessDate: toDateColumn(ctx.today),
          openUserId: ctx.user.id,
          method: ctx.method,
          recordedById: ctx.recordedById,
          shiftId: ctx.shiftId,
          stationId: ctx.station?.id ?? null,
          stationSlot: ctx.slot,
          offlineQueued: ctx.offlineQueued,
          originIpHash: ctx.originIpHash,
          offSiteOrigin: ctx.offSiteOrigin,
          // Whether an identity check WOULD have been possible — never that
          // one happened.
          photoOnFileAtTime: ctx.profile.avatarUrl !== null,
          // Snapshotted so a later reassignment does not rewrite who was
          // notified.
          assignedCoachId: assignment?.coachId ?? null,
          // This route is exempt from Idempotency-Key (ruling A). The columns
          // are NOT NULL, so a fresh uuid and a fixed sentinel hash record
          // "no client key governed this write" without a nullable column that
          // would then need a CHECK to keep honest.
          idempotencyKey: randomUUID(),
          idempotencyHash: NO_IDEMPOTENCY_HASH,
        },
      ],
      skipDuplicates: true,
    });

    if (inserted.count === 0) {
      // Two devices on one account, DIFFERENT slots, concurrent: neither
      // collided on StationScan, both reached here, and `openUserId @unique`
      // caught the second. This is the branch a same-token test cannot see.
      const existing = await tx.checkIn.findUnique({ where: { openUserId: ctx.user.id } });
      if (existing !== null) {
        return this.finish(tx, ctx, {
          outcome: 'ALREADY_INSIDE',
          checkIn: existing,
          verdict,
          subject: loaded.subject,
        });
      }
      // The sentinel cleared between the insert and this read — the other
      // request checked them straight back out. Treat it as a denial rather
      // than looping: one scan, one outcome.
      return this.denyWithoutMembership(
        tx,
        ctx,
        DenialReason.ALREADY_CHECKED_IN,
        null,
        loaded.subject,
      );
    }

    const checkIn = await tx.checkIn.findUniqueOrThrow({ where: { openUserId: ctx.user.id } });

    if (verdict.decision === 'GRACE') {
      // Grace is FINITE and COUNTED. The bound lives on the membership row, so
      // it holds whether or not the nightly job ever runs again.
      await tx.membership.update({
        where: { id: loaded.membershipId },
        data: { graceAdmissionsThisTerm: { increment: 1 } },
      });
    }

    return this.finish(tx, ctx, {
      outcome: admittedAs,
      checkIn,
      verdict,
      subject: loaded.subject,
    });
  }

  /**
   * RULING B's mechanism. `dayPassValidToday` was true, so a non-voided
   * `WALK_IN` row exists on today's business date; reopen it.
   */
  private async admitOnDayPass(
    tx: Prisma.TransactionClient,
    ctx: ScanContext,
  ): Promise<{ outcome: CheckInOutcome; checkIn: CheckIn } | null> {
    const walkIn = await tx.checkIn.findFirst({
      where: {
        userId: ctx.user.id,
        entryType: 'WALK_IN',
        businessDate: toDateColumn(ctx.today),
        voidedAt: null,
      },
      orderBy: { occurredAt: 'desc' },
    });
    if (walkIn === null) return null;

    if (walkIn.endedAt === null) {
      // Still open. Step 2 normally catches this; reachable only if the
      // sentinel and the row disagree, which the CHECK constraints forbid.
      return { outcome: 'ALREADY_INSIDE', checkIn: walkIn };
    }

    const reopened = await this.reopenVisit(tx, ctx, walkIn);
    return reopened === null ? null : { outcome: 'REOPENED', checkIn: reopened };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Writes
  // ───────────────────────────────────────────────────────────────────────

  /**
   * Conditional close. `count === 0` means another request won the race, and
   * the caller falls through rather than throwing — one scan still produces
   * exactly one outcome.
   */
  private async closeVisit(
    tx: Prisma.TransactionClient,
    ctx: ScanContext,
    open: CheckIn,
    method: 'STATION_QR' | 'STALE_CLOSE' | 'MANUAL',
  ): Promise<CheckIn | null> {
    const stationColumns =
      method === 'STATION_QR' && ctx.station !== null
        ? {
            // Where the visit was CLOSED. A separate column rather than an
            // inference through the linking StationScan row, which is purged
            // after 24h — that would make the audit trail evaporate within a
            // day of being written.
            closeStationId: ctx.station.id,
            closeStationSlot: ctx.slot,
            closeOffSiteOrigin: ctx.offSiteOrigin,
          }
        : // CheckIn_close_station_shape allows a close station only when
          // closeMethod = 'STATION_QR'. A stale close is the server noticing,
          // not the member scanning out.
          {};

    const { count } = await tx.checkIn.updateMany({
      where: { id: open.id, endedAt: null, voidedAt: null },
      data: {
        endedAt: ctx.now,
        closeMethod: method,
        openUserId: null,
        // A desk close is attributable; a self-scan close is not, because the
        // member did it themselves.
        closedById: method === 'MANUAL' ? ctx.recordedById : null,
        // CheckIn_autoclosed_agrees: autoClosed must equal
        // closeMethod IN (AUTO_CLOSE, STALE_CLOSE), in both directions.
        autoClosed: method === 'STALE_CLOSE',
        ...stationColumns,
      },
    });
    if (count === 0) return null;
    return tx.checkIn.findUniqueOrThrow({ where: { id: open.id } });
  }

  /**
   * Conditional reopen (§6.6.4). Clears every close column, restores the
   * sentinel and increments `reopenCount` — recorded rather than hidden, so a
   * dispute can see that a visit was closed and reopened.
   */
  private async reopenVisit(
    tx: Prisma.TransactionClient,
    ctx: ScanContext,
    prior: CheckIn,
  ): Promise<CheckIn | null> {
    const { count } = await tx.checkIn.updateMany({
      where: { id: prior.id, endedAt: { not: null }, voidedAt: null, openUserId: null },
      data: {
        endedAt: null,
        closeMethod: null,
        closedById: null,
        closeStationId: null,
        closeStationSlot: null,
        closeOffSiteOrigin: null,
        openUserId: ctx.user.id,
        autoClosed: false,
        reopenCount: { increment: 1 },
      },
    });
    if (count === 0) return null;
    return tx.checkIn.findUniqueOrThrow({ where: { id: prior.id } });
  }

  /**
   * The denials the ladder never reaches a membership read for —
   * `CHECKIN_DAILY_LIMIT`, `GYM_CLOSED`, `STATION_TOKEN_EXPIRED` — plus the
   * two defensive ones above. `membershipStatusAtTime` stays NULL for exactly
   * that reason.
   */
  private async denyWithoutMembership(
    tx: Prisma.TransactionClient,
    ctx: ScanContext,
    reason: DenialReason,
    tokenStalenessSeconds: number | null = null,
    subject?: AccessSubject,
  ): Promise<Decided> {
    const denial = await tx.checkInDenial.create({
      data: {
        userId: ctx.user.id,
        reason,
        method: ctx.method,
        occurredAt: ctx.now,
        businessDate: toDateColumn(ctx.today),
        membershipStatusAtTime: null,
        stationId: ctx.station?.id ?? null,
        stationSlot: ctx.slot,
        tokenStalenessSeconds,
        recordedById: ctx.recordedById,
        shiftId: ctx.shiftId,
        originIpHash: ctx.originIpHash,
        offSiteOrigin: ctx.offSiteOrigin,
      },
    });

    return this.finish(tx, ctx, {
      outcome: 'DENIED',
      denial: { id: denial.id, reason: sharedDenialReason(denial.reason) },
      subject,
      // These reasons sit above (or beside) the ladder, so there is no
      // AccessResult to carry. The presenter composes both messages from the
      // reason alone.
      verdict: syntheticDenial(reason),
    });
  }

  /** Step 5: the outcome, stamped back onto the claimed slot. */
  private async stampScan(
    tx: Prisma.TransactionClient,
    ctx: ScanContext,
    decided: Decided,
  ): Promise<void> {
    if (ctx.station === null || ctx.slot === null) return;

    await tx.stationScan.updateMany({
      where: { userId: ctx.user.id, stationId: ctx.station.id, slot: ctx.slot },
      data: {
        outcome: decided.envelope.result.outcome,
        checkInId: decided.checkInId,
        denialId: decided.denialId,
        // The EXACT rendered body. This is what makes "the replay returns an
        // identical response" literally true instead of approximately true.
        responseSnapshot: decided.envelope.result as unknown as Prisma.InputJsonValue,
      },
    });
  }

  // ───────────────────────────────────────────────────────────────────────
  // Composition
  // ───────────────────────────────────────────────────────────────────────

  private async finish(
    tx: Prisma.TransactionClient,
    ctx: ScanContext,
    outcome: OutcomeInput,
  ): Promise<Decided> {
    const verdict = outcome.verdict ?? null;
    const membership = outcome.subject?.membership ?? null;
    const checkIn = outcome.checkIn ?? null;

    // Only a member holding the phone can confirm a check-out — a desk entry
    // has no station and no button to press — and only off a code that was
    // still current. An EXPIRED token is still a recognisable second scan, so
    // it answers ALREADY_INSIDE, but it proves nothing about where the member
    // is. GYM_CLOSED is deliberately NOT excluded: a member still inside
    // after closing must be able to leave.
    const checkOutOffered =
      outcome.outcome === 'ALREADY_INSIDE' &&
      checkIn !== null &&
      ctx.station !== null &&
      !(
        ctx.preVerdict.kind === 'DENY' &&
        ctx.preVerdict.reason === DenialReason.STATION_TOKEN_EXPIRED
      );

    const presentation: CheckInPresentation = presentCheckIn({
      outcome: outcome.outcome,
      // CHECKED_OUT deliberately passes null: the goodbye card must not read
      // as an admission, and no membership was consulted to produce it.
      verdict: outcome.outcome === 'CHECKED_OUT' ? null : verdict,
      firstName: ctx.profile.firstName,
      membership,
      // "Since 3:05 PM" on the already-inside card is when the VISIT began,
      // not this scan.
      occurredAt:
        outcome.outcome === 'ALREADY_INSIDE' && checkIn !== null ? checkIn.occurredAt : ctx.now,
      timeZone: this.gym.timeZone,
      sessionMinutes:
        outcome.outcome === 'CHECKED_OUT' && checkIn?.endedAt != null
          ? (checkIn.endedAt.getTime() - checkIn.occurredAt.getTime()) / 60_000
          : null,
      checkOutOffered,
      reopenWindowMinutes: this.reopenWindowMinutes,
    });

    const summary: CheckInMembershipSummary =
      verdict === null ? EMPTY_MEMBERSHIP_SUMMARY : toCheckInMembershipSummary(membership, verdict);

    const visitNumberThisMonth =
      checkIn === null || outcome.outcome === 'CHECKED_OUT'
        ? 0
        : await tx.checkIn.count({
            where: {
              userId: ctx.user.id,
              voidedAt: null,
              businessDate: { gte: toDateColumn(firstOfMonth(ctx.today)) },
            },
          });

    const result: CheckInResult = {
      outcome: outcome.outcome,
      // Overlaid by the replay path, never set true here.
      replayed: false,
      display: presentation.display,
      checkIn:
        checkIn === null
          ? null
          : {
              id: checkIn.id,
              occurredAt: checkIn.occurredAt.toISOString(),
              businessDate: civilDateFromPrisma(checkIn.businessDate),
              verdict: sharedVerdict(checkIn.verdict),
              visitNumberThisMonth,
            },
      session:
        outcome.outcome === 'CHECKED_OUT' && checkIn?.endedAt != null
          ? {
              startedAt: checkIn.occurredAt.toISOString(),
              endedAt: checkIn.endedAt.toISOString(),
              durationMinutes: Math.round(
                (checkIn.endedAt.getTime() - checkIn.occurredAt.getTime()) / 60_000,
              ),
            }
          : null,
      denial:
        outcome.denial === undefined
          ? null
          : {
              id: outcome.denial.id,
              reason: outcome.denial.reason,
              memberMessage: presentation.memberMessage ?? presentation.display.detail ?? '',
            },
      // Stored in the scan's responseSnapshot, where `confirmCheckOut` reads
      // it back as part of the proof.
      checkOutOffered,
      nextStep: presentation.nextStep,
      membership: summary,
      // Null on a desk entry, which carries no station by construction.
      station: ctx.station === null ? null : { code: ctx.station.code, name: ctx.station.name },
      serverTime: ctx.now.toISOString(),
    };

    return {
      envelope: { result, feed: this.toFeedEvent(ctx, outcome, presentation) },
      checkInId: checkIn?.id ?? null,
      denialId: outcome.denial?.id ?? null,
    };
  }

  private toFeedEvent(
    ctx: ScanContext,
    outcome: OutcomeInput,
    presentation: CheckInPresentation,
  ): DeskFeedEvent {
    return {
      kind:
        outcome.outcome === 'DENIED'
          ? 'DENIAL'
          : outcome.outcome === 'CHECKED_OUT'
            ? 'CHECK_OUT'
            : 'CHECK_IN',
      at: ctx.now.toISOString(),
      // Composed HERE, at publish time, from data this transaction already
      // loaded. Enriching per SUBSCRIBER instead would put a database read on
      // the feed's hot path and multiply it by the number of open consoles —
      // for fields the writer had in hand a millisecond earlier.
      member: toDeskMember(
        { ...ctx.profile, id: ctx.user.id },
        outcome.subject?.membership ?? null,
        outcome.verdict ?? null,
      ),
      // The staff-directive form, which never travelled to the handset.
      staffMessage: presentation.staffMessage,
      outcome: outcome.outcome,
      checkInId: outcome.checkIn?.id ?? null,
      denialId: outcome.denial?.id ?? null,
      reason: outcome.denial?.reason ?? null,
      verdict: outcome.checkIn === undefined ? null : sharedVerdict(outcome.checkIn.verdict),
      station:
        ctx.station === null
          ? null
          : { id: ctx.station.id, code: ctx.station.code, name: ctx.station.name },
      offSiteOrigin: ctx.offSiteOrigin,
      photoOnFileAtTime: ctx.profile.avatarUrl !== null,
    };
  }

  /** The stored body, verbatim, with `replayed: true` overlaid. */
  private async replayOf(
    tx: Prisma.TransactionClient,
    ctx: ScanContext,
  ): Promise<CheckInResult | null> {
    if (ctx.station === null || ctx.slot === null) return null;

    const prior = await tx.stationScan.findUnique({
      where: {
        userId_stationId_slot: {
          userId: ctx.user.id,
          stationId: ctx.station.id,
          slot: ctx.slot,
        },
      },
      select: { responseSnapshot: true },
    });
    if (prior?.responseSnapshot == null) return null;
    return { ...(prior.responseSnapshot as unknown as CheckInResult), replayed: true };
  }

  // ───────────────────────────────────────────────────────────────────────
  // Small pure helpers
  // ───────────────────────────────────────────────────────────────────────

  /**
   * The reopen window: re-entry grace with the min-session as its floor, so
   * REENTRY_GRACE=0 disables the grace without killing the §6.6.4
   * scanned-by-mistake undo. This is the ONLY remaining reader of
   * CHECKIN_MIN_SESSION_MINUTES — it no longer gates a check-out.
   */
  private get reopenWindowMinutes(): number {
    return Math.max(this.gym.checkinReentryGraceMinutes, this.gym.checkinMinSessionMinutes);
  }

  private get reopenWindowMs(): number {
    return this.reopenWindowMinutes * 60_000;
  }

  /**
   * Today's window, from the editable table with the environment as the floor.
   *
   * This used to read `GYM_OPEN_TIME` / `GYM_CLOSE_TIME` directly, which is
   * why the website could advertise 11pm while the door shut at 10 — the copy
   * and the gate had no shared source. `OpeningHoursService` degrades to
   * exactly those two variables whenever the table cannot answer, so the
   * guarantee that made them environment in the first place still holds.
   */
  private async hoursFor(now: Date): Promise<GymHours> {
    const day = await this.openingHours.forDate(now);
    return {
      timeZone: this.gym.timeZone,
      openTime: day.opensAt,
      closeTime: day.closesAt,
      isClosed: day.isClosed,
    };
  }

  /**
   * The gym-hours gate, scoped to `STATION_QR` and living HERE rather than in
   * `accessVerdict()` — that function is a pure function of a `CivilDate` with
   * no time-of-day, and an hours check inside it would break both its purity
   * and its test contract.
   */
  private async gymHoursDenial(now: Date): Promise<PreVerdict> {
    const hours = await this.hoursFor(now);

    // A day marked closed is a decision somebody made on a screen that said
    // so, and it is the only way this gate refuses everybody all day.
    if (hours.isClosed === true) {
      this.logger.warn(`Self-scan on a day marked closed at ${now.toISOString()}.`);
      return { kind: 'DENY', reason: DenialReason.GYM_CLOSED };
    }

    if (isWithinGymHours(now, hours)) return { kind: 'PROCEED' };
    this.logger.warn(
      `Self-scan outside gym hours (${hours.openTime}-${hours.closeTime}) at ${now.toISOString()}.`,
    );
    return { kind: 'DENY', reason: DenialReason.GYM_CLOSED };
  }

  /**
   * `[STATION_TOKEN_SECRET, STATION_TOKEN_SECRET_PREVIOUS?]`, in that order.
   * The previous secret is verify-only by construction — nothing signs with
   * it — so dropping it on the following deploy invalidates every outstanding
   * token everywhere within one slot. That is the global panic button.
   */
  private verifySecrets(): string[] {
    const current: string = this.config.get('STATION_TOKEN_SECRET');
    const previous = this.config.get('STATION_TOKEN_SECRET_PREVIOUS', { infer: true });
    return previous === undefined ? [current] : [current, previous];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Types local to the write path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The two denials decided BEFORE the ladder runs. Both still write a
 * `CheckInDenial` and both still return 200 — the member scanned a real code
 * for the real station and was a few seconds late, or the gym is shut. Those
 * are business outcomes the phone must render calmly, not exceptions.
 */
type PreVerdict =
  { kind: 'PROCEED' } | { kind: 'DENY'; reason: DenialReason; tokenStalenessSeconds?: number };

interface ScanProfile {
  avatarUrl: string | null;
  firstName: string;
  lastName: string;
  memberCode: string | null;
}

/**
 * Who is being admitted — NOT who is asking.
 *
 * On a self-scan those are the same person. On a desk entry they are not: the
 * subject is a member standing at the counter and the caller is the operator
 * recording them. Typing this as `AuthUser` was fine while only one path
 * existed and would have been a quiet bug the moment a second one did.
 */
interface EntrySubject {
  id: string;
  role: Role;
}

/**
 * One context for every way an entry is recorded.
 *
 * §6.13.2's central claim is that every path goes through ONE write core. That
 * is worth holding on to: the door ladder, the open-visit rules, the stale
 * close, the reopen window and the daily ceiling are identical whether a
 * member scanned or a staffer typed, and two copies of them would disagree
 * within a release.
 *
 * What differs is narrow and lives in nullable columns: a station entry has a
 * station and a slot and no recorder; a desk entry has a recorder and a shift
 * and no station. Both biconditionals are enforced by CHECK constraints, so a
 * mistake here is a rejected row rather than a lie in a fraud column.
 */
interface ScanContext {
  user: EntrySubject;
  profile: ScanProfile;
  /** NULL on a desk-recorded entry. */
  station: { id: string; code: string; name: string } | null;
  slot: number | null;
  method: PrismaCheckInMethod;
  /**
   * NULL on a self-scan — nobody recorded it, the accountable party is the
   * member — and the operator on a desk entry. Biconditional with
   * `method = 'STATION_QR'`, enforced by `CheckIn_recorder_shape`.
   */
  recordedById: string | null;
  originIpHash: string | null;
  offSiteOrigin: boolean;
  /**
   * Best-effort on a self-scan and REQUIRED on a desk entry: money or a staff
   * action must always be reconcilable to a counted drawer.
   */
  shiftId: string | null;
  /** The desk's own offline queue. Never the member's — there isn't one. */
  offlineQueued: boolean;
  now: Date;
  today: CivilDate;
  preVerdict: PreVerdict;
  /**
   * The reason of the denial an ADMIN is overriding, or null. Relaxes exactly
   * that gate in `admit()` — today only CHECKIN_DAILY_LIMIT — never the whole
   * ladder.
   */
  overriding: PrismaDenialReason | null;
}

interface OutcomeInput {
  outcome: CheckInOutcome;
  checkIn?: CheckIn;
  denial?: { id: string; reason: DenialReason };
  verdict?: AccessResult;
  subject?: AccessSubject;
}

interface Decided {
  envelope: { result: CheckInResult; feed: DeskFeedEvent | null };
  checkInId: string | null;
  denialId: string | null;
}

/**
 * `idempotencyHash` is `CHAR(64) NOT NULL` and this route is Idempotency-Key
 * exempt. Sixty-four zeros is a value no SHA-256 digest of a real body will
 * ever collide with, and it reads unmistakably as "no client key governed this
 * write" in a table where every other row's hash is meaningful.
 */
const NO_IDEMPOTENCY_HASH = '0'.repeat(64);

/**
 * How recent the member's `ALREADY_INSIDE` scan must be for the Check out
 * button to close their visit — and how long a double tap keeps answering
 * with the same CHECKED_OUT card. Two minutes is long enough to read the card
 * and tap, short enough that a screenshot of it is worthless from home
 * (owner-approved, 2026-10-20). A constant, not env: it is a security bound,
 * not a gym preference.
 */
export const CHECK_OUT_CONFIRM_WINDOW_MS = 2 * 60_000;

function checkOutNotOpen(): DomainException {
  return new DomainException('CHECK_OUT_NOT_OPEN', "You're not checked in.", HttpStatus.CONFLICT);
}

/** Renderable with no membership at all — this is never a 404 state. */
const EMPTY_MEMBERSHIP_SUMMARY: CheckInMembershipSummary = {
  planName: null,
  status: null,
  endsOn: null,
  daysRemaining: null,
  decision: 'DENY',
};

/**
 * An `AccessResult` for the reasons that sit above or beside the ladder rather
 * than inside it. `message` is the STAFF directive; the member's copy is
 * derived from `denialReason` by the presenter and never from this string.
 */
function syntheticDenial(reason: DenialReason): AccessResult {
  const staffMessage: Record<string, string> = {
    [DenialReason.STATION_TOKEN_EXPIRED]:
      'That code had already rolled over. Ask them to scan the current one.',
    [DenialReason.GYM_CLOSED]:
      'Outside gym hours — check the configured opening times if this looks wrong.',
    [DenialReason.CHECKIN_DAILY_LIMIT]:
      'Daily visit ceiling reached. Override with a PIN if this is legitimate.',
    [DenialReason.ALREADY_CHECKED_IN]: 'Already inside on another device. Nothing to do.',
    [DenialReason.NO_MEMBERSHIP]: 'No plan on file. Sell a walk-in, or sign them up.',
  };

  return {
    decision: 'DENY',
    verdict: null,
    allowReason: null,
    denialReason: reason,
    message: staffMessage[reason] ?? 'Refused at the door. Check the account.',
    relevantDate: null,
    daysRemaining: null,
    graceDaysRemaining: 0,
    offer: reason === DenialReason.CHECKIN_DAILY_LIMIT ? 'OVERRIDE' : 'NONE',
  };
}

/**
 * Prisma cannot import from `@got/shared`, so every enum both runtimes switch
 * on is duplicated by hand and bridged with a cast at the seam — the same
 * pattern `membership.presenter.ts` uses. `enum-parity.spec.ts` is what makes
 * these casts safe rather than hopeful: it fails the build if the two
 * definitions ever disagree, and a drifted `DenialReason` renders a blank
 * verdict card in a member's hand at the counter.
 */
function sharedDenialReason(value: PrismaDenialReason): DenialReason {
  return value as unknown as DenialReason;
}

function sharedVerdict(value: PrismaAccessVerdict): AccessVerdict {
  return value as unknown as AccessVerdict;
}

/** '2026-08-20' → '2026-08-01'. Pure string work on a CivilDate. */
function firstOfMonth(today: CivilDate): CivilDate {
  return `${today.slice(0, 7)}-01` as CivilDate;
}
