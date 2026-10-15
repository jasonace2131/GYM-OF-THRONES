import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import type { DenialReason } from '@prisma/client';
import type { CheckInRecord, CheckInResult } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { civilDateFromPrisma, gymToday } from '../common/time/gym-time';
import { CheckInService } from '../checkin/check-in.service';
import { DeskFeedService } from '../checkin/desk-feed.service';
import type { AuthUser } from '../auth/auth.types';
import { CreateManualCheckInDto } from './dto/desk-check-in.dto';
import type { OverrideDenialDto } from './dto/override-denial.dto';
import { toCheckInRecord } from './desk.presenter';

/**
 * The desk's own writes: record a member by hand, close a visit, void one.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE MANUAL PATH IS A MAIN ROAD, NOT A FALLBACK.
 *
 * A quarter of arrivals cannot self-scan on any given day — no smartphone, a
 * dead battery, a phone in a locker, no signal, a cracked screen, an old
 * handset that will not decode a glossy panel. Before this existed, every one
 * of those members simply could not get in. That is the gap this closes.
 *
 * THREE THINGS DIFFER FROM THE MEMBER'S OWN SCAN, and each is deliberate:
 *
 *   1. NO GYM-HOURS GATE. Route 43 refuses a self-scan outside opening hours;
 *      this route never does. The caller is a named, accountable operator with
 *      a member standing in front of them, and an early opening, a public
 *      holiday or a `GYM_TIMEZONE` typo must not leave staff unable to record
 *      anything. A staff-attributed entry does not need a clock to authorise
 *      it.
 *
 *   2. `recordedById` AND `shiftId` ARE BOTH REQUIRED. A staff action is
 *      always reconcilable to a named person and a counted drawer. Both are
 *      enforced by CHECK constraints, so a bug here is a rejected row rather
 *      than an unattributable entry.
 *
 *   3. THE ORIGIN SIGNAL IS NOT RECORDED. `originIpHash` stays null. The relay
 *      signal in §6.11.2 is about the MEMBER's own device; stamping the desk's
 *      address onto every manual entry would fill that column with the gym's
 *      own IP and quietly dilute the one signal a live relay cannot evade.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Everything else — the door ladder, the open-visit rules, the stale close,
 * the reopen window, the daily ceiling, the response composition — is the
 * SAME CODE the member's scan runs, reached through `CheckInService`. Two
 * copies of that logic would disagree within a release.
 */
@Injectable()
export class DeskCheckInService {
  private readonly logger = new Logger(DeskCheckInService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly checkIns: CheckInService,
    private readonly deskFeed: DeskFeedService,
    private readonly audit: AuditService,
  ) {}

  /** Route 45. */
  async record(
    operator: AuthUser,
    dto: CreateManualCheckInDto,
    now: Date = new Date(),
    overriding?: DenialReason,
  ): Promise<CheckInResult> {
    const member = await this.resolveMember(dto);

    // Money or a staff action must always be reconcilable to a counted drawer.
    // Unlike the self-scan path, this one HARD-FAILS without one.
    const shift = await this.prisma.shift.findFirst({
      where: { closedAt: null },
      select: { id: true },
    });
    if (shift === null) {
      throw new DomainException(
        'SHIFT_NOT_OPEN',
        'Open the cash drawer before recording a check-in.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // The photo is the desk's identity control on this path. With no photo the
    // operator is asserting recognition instead, and that assertion is made
    // explicitly rather than inferred from a missing column.
    if (member.avatarUrl === null && dto.identityConfirmed !== true) {
      throw new DomainException(
        'CONFIRMATION_REQUIRED',
        'This member has no photo on file. Confirm you recognise them.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const occurredAt = this.resolveOccurredAt(dto.occurredAt, now);

    return this.checkIns.recordDeskEntry({
      subject: { id: member.id, role: member.role },
      profile: {
        avatarUrl: member.avatarUrl,
        firstName: member.firstName,
        lastName: member.lastName,
        memberCode: member.memberCode,
      },
      // A TYPED CODE and a NAME SEARCH are different identity claims and are
      // told apart in the data on purpose, so a later fraud review can
      // distinguish "they had their card" from "a staffer recognised them".
      method: dto.memberCode === undefined ? 'MANUAL' : 'MEMBER_CODE',
      recordedById: operator.id,
      shiftId: shift.id,
      offlineQueued: dto.offlineQueued === true,
      occurredAt,
      overriding,
    });
  }

  /**
   * Route 48 — admitting somebody the door turned away.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * THIS ADMITS A MEMBER WHO DOES NOT CURRENTLY QUALIFY, AND WRITES DOWN WHO
   * DECIDED THAT.
   *
   * `checkin.override` is the one permission in the catalogue marked dangerous.
   * The whole value of the route is the paper trail: `overriddenById`,
   * `overrideReason`, and the denial moving to OVERRIDDEN pointing at the entry
   * that converted it. An owner reading the denial report a month later can see
   * exactly who let whom in for free, and why.
   * ═══════════════════════════════════════════════════════════════════════════
   *
   * NO `ALLOWED_OVERRIDE` VERDICT IS WRITTEN, and that is deliberate rather
   * than an omission. The route table's row says `verdict: ALLOWED_OVERRIDE`,
   * but `AccessVerdict` in @got/shared says the opposite in as many words:
   * "there is deliberately no ALLOWED_OVERRIDE, because an override writes
   * CheckInDenial.outcome = OVERRIDDEN and no CheckIn verdict". The type
   * comment is the later and better-reasoned of the two — widening that enum
   * is the migration shape this schema's own comments warn recreates the table
   * and drops every hand-written CHECK — so the denial row carries the fact and
   * the CheckIn stays an ordinary admission.
   */
  async overrideDenial(
    operator: AuthUser,
    denialId: string,
    dto: OverrideDenialDto,
    now: Date = new Date(),
  ): Promise<CheckInResult> {
    const denial = await this.prisma.checkInDenial.findUnique({
      where: { id: denialId },
      select: { id: true, userId: true, outcome: true, reason: true },
    });

    if (denial === null) {
      throw new DomainException(
        'DENIAL_NOT_FOUND',
        'That denial no longer exists.',
        HttpStatus.NOT_FOUND,
      );
    }

    if (denial.outcome !== 'UNRESOLVED') {
      // Already converted — by a walk-in sale, another override, or marked
      // abandoned. Overriding it again would write a second admission for one
      // refusal and double-count the funnel.
      throw new DomainException(
        'DENIAL_ALREADY_RESOLVED',
        'That denial has already been dealt with.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // The admission itself goes through route 45's path, so the open-shift
    // requirement, the photo/identity rule, the door ladder and the desk feed
    // are the same code. The denial's own reason travels as `overriding`,
    // which relaxes EXACTLY that gate in the ladder (today: the daily
    // ceiling) — without it, overriding a CHECKIN_DAILY_LIMIT denial re-ran
    // the same ceiling and produced a second identical denial while marking
    // the first resolved.
    const admitted = new CreateManualCheckInDto();
    admitted.userId = denial.userId;
    admitted.identityConfirmed = true;

    const result = await this.record(operator, admitted, now, denial.reason);

    // CONDITIONAL on still being UNRESOLVED, so two managers tapping at once
    // produce one override and one no-op rather than two. The admission above
    // has already happened either way, which is the right order: a member
    // standing at the counter gets in, and the bookkeeping resolves itself.
    await this.prisma.checkInDenial.updateMany({
      where: { id: denialId, outcome: 'UNRESOLVED' },
      data: {
        outcome: 'OVERRIDDEN',
        overriddenById: operator.id,
        overrideReason: dto.reason,
        resolvedAt: now,
        ...(result.checkIn === null ? {} : { resolvedByCheckInId: result.checkIn.id }),
      },
    });

    /*
     * `checkin.override` is the only key in the catalogue marked dangerous, so
     * this is the entry the audit screen exists for above all others.
     *
     * The SUBJECT is the denial, not the admission it produced: the question
     * somebody asks later is "who let this refusal through", and the visit is
     * reachable from `resolvedByCheckInId` on the row named here.
     */
    await this.audit.record(
      {
        action: 'CHECKIN_OVERRIDDEN',
        actorId: operator.id,
        actorRole: operator.role,
        subjectType: 'CheckInDenial',
        subjectId: denialId,
        subjectLabel: denial.reason,
        reason: dto.reason,
        details: {
          memberId: denial.userId,
          deniedFor: denial.reason,
          admittedAs: result.checkIn?.id ?? null,
        },
      },
      now,
    );

    return result;
  }

  /**
   * Route 46 — the rail's `⏻ CHECK OUT`.
   *
   * A CONDITIONAL update, guarded on the visit still being open and not
   * voided. Two operators tapping at once produce exactly one winner; the
   * loser gets a 422 rather than silently stamping a second close over the
   * first.
   */
  async checkOut(
    operator: AuthUser,
    checkInId: string,
    endedAtIso: string | undefined,
    now: Date = new Date(),
  ): Promise<CheckInRecord> {
    const endedAt = this.resolveOccurredAt(endedAtIso, now);

    const { count } = await this.prisma.checkIn.updateMany({
      where: { id: checkInId, endedAt: null, voidedAt: null },
      data: {
        endedAt,
        closeMethod: 'MANUAL',
        closedById: operator.id,
        // The sentinel is cleared in the same statement that sets `endedAt`.
        // `CheckIn_open_marker_agrees` makes the two inseparable, which is what
        // stops a closed visit staying invisible to the unique index.
        openUserId: null,
        autoClosed: false,
      },
    });

    if (count === 0) {
      const existing = await this.prisma.checkIn.findUnique({ where: { id: checkInId } });
      if (existing === null) {
        throw new DomainException('CHECKIN_NOT_FOUND', 'No such visit.', HttpStatus.NOT_FOUND);
      }
      throw new DomainException(
        existing.voidedAt === null ? 'CHECKIN_ALREADY_CLOSED' : 'CHECKIN_ALREADY_VOIDED',
        existing.voidedAt === null ? 'That visit is already closed.' : 'That visit was voided.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const record = await this.loadRecord(checkInId, now);
    this.publish(record, 'CHECK_OUT', `Checked out by ${operator.firstName}.`);
    return record;
  }

  /**
   * Route 47 — void a visit.
   *
   * A VOID IS A CORRECTION, NEVER A DELETE. The row stays and every count that
   * matters already filters on `voidedAt`. Deleting would remove the evidence
   * that a mistake was made, which is the one thing an audit trail is for.
   */
  async void(
    operator: AuthUser,
    checkInId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<CheckInRecord> {
    const existing = await this.prisma.checkIn.findUnique({ where: { id: checkInId } });
    if (existing === null) {
      throw new DomainException('CHECKIN_NOT_FOUND', 'No such visit.', HttpStatus.NOT_FOUND);
    }
    if (existing.voidedAt !== null) {
      throw new DomainException(
        'CHECKIN_ALREADY_VOIDED',
        'That visit is already voided.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    await this.prisma.checkIn.update({
      where: { id: checkInId },
      data: {
        voidedAt: now,
        voidedById: operator.id,
        voidReason: reason,
        // A voided visit must not hold the open-visit sentinel: the member
        // would otherwise be unable to check in again at all, because the
        // unique index still counts a row nobody can see.
        ...(existing.openUserId === null
          ? {}
          : { openUserId: null, endedAt: now, closeMethod: 'MANUAL', closedById: operator.id }),
      },
    });

    this.logger.warn(`CheckIn ${checkInId} voided by ${operator.id}: ${reason}`);

    // The log line above is for whoever is tailing the process. This is for
    // whoever asks, in three weeks, why a member's attendance is one short.
    await this.audit.record(
      {
        action: 'CHECKIN_VOIDED',
        actorId: operator.id,
        actorRole: operator.role,
        subjectType: 'CheckIn',
        subjectId: checkInId,
        subjectLabel: civilDateFromPrisma(existing.businessDate),
        reason,
        details: { memberId: existing.userId, entryType: existing.entryType },
      },
      now,
    );

    return this.loadRecord(checkInId, now);
  }

  // ───────────────────────────────────────────────────────────────────────

  private async resolveMember(dto: CreateManualCheckInDto): Promise<{
    id: string;
    role: 'CLIENT' | 'FRONT_DESK' | 'COACH' | 'ADMIN' | 'DEV';
    firstName: string;
    lastName: string;
    memberCode: string | null;
    avatarUrl: string | null;
  }> {
    const member = await this.prisma.user.findFirst({
      where: {
        deletedAt: null,
        ...(dto.userId === undefined ? { memberCode: dto.memberCode } : { id: dto.userId }),
      },
      select: {
        id: true,
        role: true,
        firstName: true,
        lastName: true,
        memberCode: true,
        avatarUrl: true,
        status: true,
      },
    });

    if (member === null) {
      // The same 404 for a bad id and a bad code. A distinguishable answer
      // would let anyone with desk access confirm which member codes exist.
      throw new DomainException('MEMBER_NOT_FOUND', 'Member not found', HttpStatus.NOT_FOUND);
    }

    return member;
  }

  /**
   * The desk queue's clamp.
   *
   * A supplied instant may be in the past — the console is flushing writes it
   * buffered while the network was down — but never in the FUTURE and never
   * older than `CHECKIN_OFFLINE_MAX_AGE_HOURS`. Both bounds are rejections
   * rather than silent clamps: a queue flushing a two-day-old entry is a bug
   * in the console, and quietly rewriting its timestamp would hide it while
   * putting a wrong visit on a wrong business date.
   */
  private resolveOccurredAt(iso: string | undefined, now: Date): Date {
    if (iso === undefined) return now;

    const at = new Date(iso);
    const oldest = now.getTime() - this.gym.checkinOfflineMaxAgeHours * 3_600_000;

    if (Number.isNaN(at.getTime()) || at.getTime() > now.getTime() || at.getTime() < oldest) {
      throw new DomainException(
        'CHECKIN_OCCURRED_AT_OUT_OF_RANGE',
        `occurredAt must be within the last ${this.gym.checkinOfflineMaxAgeHours} hours and not in the future.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return at;
  }

  private async loadRecord(checkInId: string, now: Date): Promise<CheckInRecord> {
    const row = await this.prisma.checkIn.findUniqueOrThrow({
      where: { id: checkInId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            memberCode: true,
            avatarUrl: true,
            status: true,
            membership: {
              include: { holds: { where: { activeMembershipId: { not: null } }, take: 1 } },
            },
          },
        },
        station: { select: { code: true, name: true } },
      },
    });

    return toCheckInRecord(row, gymToday(now, this.gym.timeZone), {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    });
  }

  /** After the write, never inside it — see `DeskFeedService`. */
  private publish(record: CheckInRecord, kind: 'CHECK_OUT', staffMessage: string): void {
    this.deskFeed.publish({
      kind,
      at: record.endedAt ?? record.occurredAt,
      member: record.member,
      staffMessage,
      outcome: 'CHECKED_OUT',
      checkInId: record.checkInId,
      denialId: null,
      reason: null,
      verdict: record.verdict,
      station: null,
      offSiteOrigin: false,
      photoOnFileAtTime: record.member.avatarUrl !== null,
    });
  }
}
