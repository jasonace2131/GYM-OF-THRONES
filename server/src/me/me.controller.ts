import { Controller, Delete, Get, HttpStatus, Patch, Post, Query } from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { ProgressService } from './progress.service';
import { MemberCodeIssuer, type MyCheckInCode } from '../checkin/member-code.issuer';
import { BookingsService } from '../classes/bookings.service';
import type { MyBooking } from '../classes/class.presenter';
import { ListMyBookingsQueryDto } from '../classes/dto/class-session.dto';
import type { ProgressSummary } from './progress.presenter';
import { DomainException } from '../common/exceptions/domain.exception';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { gymToday } from '../common/time/gym-time';
import { MembershipService } from '../membership/membership.service';
import { toMembershipDetail } from '../membership/membership.presenter';
import { accessVerdict } from '../membership/access-verdict';
import { PaymentsService, type PaymentListResult } from '../payments/payments.service';
import type { MyBookingWindowWire, MyCheckIn, MyCheckInSummary, PaginatedData } from '@got/shared';
import { ListPaymentsQueryDto } from '../payments/dto/list-payments-query.dto';
import type { MemberOverview, MyCoach, MyMembership } from './me.presenter';
import { MeCheckInsService } from './me-check-ins.service';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';

/**
 * Routes 10, 11 and 12 — keyless, hard-coded to the caller's own userId,
 * exactly like the existing GET /me.
 *
 * There is deliberately NO @RequirePermission and NO @Scope here. CLIENT is
 * granted none of the membership.* or payment.* keys, so `OWN` never has to
 * mean two different things depending on whether the caller is a member or a
 * coach. AuthGuard is global, so these routes are still authenticated.
 *
 * Nest resolves this alongside UsersController's @Controller('me') — that one
 * owns @Get() and these own their sub-paths, so there is no collision.
 */
@Controller('me')
export class MeController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
    private readonly memberships: MembershipService,
    private readonly payments: PaymentsService,
    private readonly checkIns: MeCheckInsService,
    private readonly progress: ProgressService,
    private readonly checkInCodes: MemberCodeIssuer,
    private readonly bookings: BookingsService,
  ) {}

  @Get('overview')
  async overview(@CurrentUser() user: AuthUser): Promise<MemberOverview> {
    const now = new Date();
    const mine = await this.myMembership(user, now);

    const lastPayment = await this.payments.listForMember(user.id, {
      page: 1,
      limit: 1,
      // Archived rows are a soft delete — excluded here as everywhere else
      // that does not explicitly ask for them.
      archived: false,
    });

    return {
      userId: user.id,
      memberCode: mine.membership?.memberCode ?? null,
      firstName: user.firstName,
      lastName: user.lastName,
      status: user.status,
      membership: mine.membership,
      verdict: mine.verdict,
      guestPassesRemaining: mine.membership?.guestPassesRemaining ?? 0,
      lastPayment: lastPayment.items[0] ?? null,
    };
  }

  @Get('membership')
  async membership(@CurrentUser() user: AuthUser): Promise<MyMembership> {
    return this.myMembership(user, new Date());
  }

  /**
   * Route 13 — the member's own visit history.
   *
   * Narrower than the desk's projection on purpose: no relay signal, no
   * staleness, no member card. Those are staff-facing facts about a member,
   * not facts a member needs about themselves.
   */
  @Get('check-ins')
  async checkInHistory(
    @CurrentUser() user: AuthUser,
    @Query() query: PaginationQueryDto,
  ): Promise<PaginatedData<MyCheckIn>> {
    return this.checkIns.history(user.id, query);
  }

  /** Route 14 — the dashboard's counters, streak and heatmap buckets. */
  @Get('check-ins/summary')
  async checkInSummary(@CurrentUser() user: AuthUser): Promise<MyCheckInSummary> {
    return this.checkIns.summary(user.id);
  }

  @Get('payments')
  async paymentHistory(
    @CurrentUser() user: AuthUser,
    @Query() query: ListPaymentsQueryDto,
  ): Promise<PaymentListResult> {
    return this.payments.listForMember(user.id, query);
  }

  /**
   * The member's own body data — measurements, goals, the derived summary, and
   * who recorded each entry (`recordedBy`, null for the member's own old rows).
   *
   * Keyless like the rest of /me: the subject is `request.user` and there is
   * no parameter that could name anybody else. READ-ONLY for the member since
   * the owner moved recording to the assigned coach — the writes are the
   * coach's, under `/me/coaching/members/:memberId/*`.
   */
  @Get('progress')
  async progressSummary(@CurrentUser() user: AuthUser): Promise<ProgressSummary> {
    return this.progress.summary(user.id);
  }

  // ── The member's old progress write routes: 403 stubs (D5) ──────────────
  //
  // Kept for ONE release so a phone still running the previous bundle gets a
  // sentence it can show — "your coach records your progress now" — rather
  // than a bare 404 from a route that silently vanished. Removed after that.
  //
  // NO @Body() and no ParseUUIDPipe, deliberately: the ValidationPipe would
  // otherwise answer an old client's body with a 400 BEFORE the handler could
  // say why, and nothing here reads the request at all. Nothing is written.

  @Post('measurements')
  recordMeasurement(): never {
    throw progressRecordedByCoach();
  }

  @Delete('measurements/:id')
  removeMeasurement(): never {
    throw progressRecordedByCoach();
  }

  @Post('goals')
  createGoal(): never {
    throw progressRecordedByCoach();
  }

  @Patch('goals/:id')
  updateGoal(): never {
    throw progressRecordedByCoach();
  }

  @Delete('goals/:id')
  removeGoal(): never {
    throw progressRecordedByCoach();
  }

  /**
   * The member's own fallback code, for when their phone cannot reach the API
   * to scan the station QR — a queue at the door, a dead access point, data
   * switched off. Staff scan this instead and the member's connectivity stops
   * mattering.
   *
   * Signed and valid for about two minutes, so a screenshot passed to a friend
   * is worthless. Minted one slot at a time: a batch would only widen that
   * window, and a phone with no connectivity cannot call this anyway.
   */
  @Get('checkin-code')
  async checkInCode(@CurrentUser() user: AuthUser): Promise<MyCheckInCode> {
    return this.checkInCodes.issue(user.id);
  }

  /** The member's own class bookings in a window of gym days, soonest first. */
  @Get('bookings')
  async myBookings(
    @CurrentUser() user: AuthUser,
    @Query() query: ListMyBookingsQueryDto,
  ): Promise<MyBooking[]> {
    return this.bookings.mine(user.id, query);
  }

  /**
   * How far ahead the member may book (14 gym days, today included; 21 on a
   * priority plan) and whether their plan lets them book today, with the
   * reason in their own words when it does not.
   *
   * Keyless like the rest of /me — the subject is the token's user. It only
   * EXPLAINS: every booking is checked again on the server, on the class's
   * own day, so this answer can never let anybody book what they may not.
   */
  @Get('booking-window')
  async myBookingWindow(@CurrentUser() user: AuthUser): Promise<MyBookingWindowWire> {
    return this.bookings.bookingWindow(user.id);
  }

  /**
   * The member's own assigned coach — see `MyCoach` for why this exists and
   * why it is deliberately narrow.
   *
   * No permission key, like every other route on this controller: the id is
   * taken from the token, never from the request. A CLIENT does not hold
   * `coach.read`, so this is the only way they can learn who coaches them —
   * and it tells them nothing a notice board would not.
   */
  @Get('coach')
  async myCoach(@CurrentUser() user: AuthUser): Promise<MyCoach> {
    const assignment = await this.prisma.coachAssignment.findUnique({
      // The nullable-unique sentinel: set to memberId while ACTIVE, NULL
      // once ended. Reading it rather than filtering on status is what makes
      // "at most one active coach" a database guarantee rather than a hope.
      where: { activeMemberId: user.id },
      select: {
        startedAt: true,
        coachId: true,
        coach: {
          select: {
            firstName: true,
            lastName: true,
            avatarUrl: true,
            // Staff & Access: the profile an admin wrote for them.
            coachProfile: { select: { specializations: true, bio: true } },
          },
        },
      },
    });

    if (assignment === null) {
      return { coach: null, profile: null, since: null, upcomingClasses: [] };
    }

    const sessions = await this.prisma.classSession.findMany({
      where: {
        coachId: assignment.coachId,
        cancelledAt: null,
        startsAt: { gte: new Date() },
      },
      orderBy: { startsAt: 'asc' },
      take: 5,
      select: {
        id: true,
        title: true,
        startsAt: true,
        endsAt: true,
        capacity: true,
        bookedCount: true,
      },
    });

    const { coachProfile, ...coach } = assignment.coach;
    return {
      coach,
      profile: coachProfile ?? null,
      since: assignment.startedAt.toISOString(),
      upcomingClasses: sessions.map((session) => ({
        ...session,
        startsAt: session.startsAt.toISOString(),
        endsAt: session.endsAt.toISOString(),
      })),
    };
  }

  private async myMembership(user: AuthUser, now: Date): Promise<MyMembership> {
    const today = gymToday(now, this.gym.timeZone);
    const subject = await this.memberships.loadSubject(user.id, today);
    const cfg = {
      expiringSoonDays: this.gym.expiringSoonDays,
      graceAdmissionsMax: this.gym.graceAdmissionsMax,
    };
    const verdict = accessVerdict(subject, today, cfg);

    if (subject.membership === null) return { membership: null, verdict };

    const row = await this.prisma.membership.findUniqueOrThrow({
      where: { userId: user.id },
      include: {
        user: { select: { firstName: true, lastName: true, memberCode: true, status: true } },
        holds: { where: { activeMembershipId: { not: null } }, take: 1 },
        events: { orderBy: { effectiveAt: 'desc' }, take: 0 },
      },
    });

    // payments: null and includeEvents: false — the member has /me/payments for
    // their own money, and every event carries an actorId naming a staff member,
    // which is not the member's business.
    return {
      membership: toMembershipDetail(row, today, cfg, { payments: null, includeEvents: false }),
      verdict,
    };
  }
}

/** The one answer every retired member progress write gives. */
function progressRecordedByCoach(): DomainException {
  return new DomainException(
    'PROGRESS_RECORDED_BY_COACH',
    'Your coach records your progress now. Ask at the front desk about personal coaching.',
    HttpStatus.FORBIDDEN,
  );
}
