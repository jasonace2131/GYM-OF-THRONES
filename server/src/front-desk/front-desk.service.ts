import { HttpStatus, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type {
  ActiveCheckIn,
  DeskCounters,
  DeskMember,
  DeskTodayPayload,
  PaginatedData,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { GymConfigService } from '../config/gym.config';
import { DomainException } from '../common/exceptions/domain.exception';
import { gymToday, toDateColumn, type CivilDate } from '../common/time/gym-time';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { accessVerdict, type AccessResult } from '../membership/access-verdict';
import { toMembershipSnapshot } from '../membership/membership.presenter';
import {
  SELLABLE_DENIAL_REASONS,
  cursorFrom,
  toActiveCheckIn,
  toDeskArrival,
  toDeskDenial,
  toDeskGuest,
  toDeskMember,
  toDeskStationStatus,
} from './desk.presenter';

/**
 * The console's read side: who is in the building, what arrived, what was
 * refused, and whether the display is still painting.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY `GET /front-desk/today` IS BOTH THE FALLBACK AND THE CATCH-UP.
 *
 * The SSE feed is the live channel, and a live channel that has no tested
 * fallback is a live channel that fails silently. This one endpoint is (a) the
 * 3-second poll when the stream will not open, and (b) the reconnect catch-up
 * after it drops — so the fallback is exercised on every reconnect rather than
 * being dead code nobody notices has rotted.
 *
 * `?since=` makes both cheap: pass back the previous `cursor` and only rows
 * that changed since come down. The cursor is `updatedAt`, not `createdAt`,
 * because a CHECK-OUT is an UPDATE — keying on creation would make every
 * departure invisible to a polling console.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * Every projection here goes through `DeskMember`, which is a privacy boundary
 * rather than a convenience type — see `desk.presenter.ts`.
 */
@Injectable()
export class FrontDeskService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gym: GymConfigService,
  ) {}

  /** Route 50 — the "who is in the building" board. */
  async activeCheckIns(
    query: PaginationQueryDto,
    now: Date = new Date(),
  ): Promise<PaginatedData<ActiveCheckIn>> {
    const today = gymToday(now, this.gym.timeZone);
    const where = openVisitWhere(toDateColumn(today));

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.checkIn.findMany({
        where,
        include: MEMBER_INCLUDE,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        ...paginationSkipTake(query),
      }),
      this.prisma.checkIn.count({ where }),
    ]);

    return paginated(
      rows.map((row) =>
        toActiveCheckIn(
          { ...row, station: row.station },
          this.personOf(row.user, row.guestName, today),
          now,
        ),
      ),
      total,
      query,
    );
  }

  /**
   * The one read that crosses the `DeskMember` boundary — deliberately.
   *
   * `guestPhone` and `guestEmergencyContact` never travel on any desk
   * projection (the lobby screen must not show them), but converting a
   * walk-in guest into a member means re-keying data the sale already
   * collected. This route exists for exactly that hand-off: it is gated on
   * `member.create` — you may see the guest's contact details only if you
   * are the person about to create their account — and returns a guest row
   * or nothing, never a member's.
   */
  async guestContact(checkInId: string): Promise<{
    guestName: string | null;
    guestPhone: string | null;
    guestEmail: string | null;
    guestEmergencyContact: string | null;
  }> {
    const row = await this.prisma.checkIn.findUnique({
      where: { id: checkInId },
      select: {
        userId: true,
        guestName: true,
        guestPhone: true,
        guestEmail: true,
        guestEmergencyContact: true,
      },
    });
    if (row === null || row.userId !== null) {
      throw new DomainException(
        'GUEST_NOT_FOUND',
        'That check-in is not a guest visit.',
        HttpStatus.NOT_FOUND,
      );
    }
    return {
      guestName: row.guestName,
      guestPhone: row.guestPhone,
      guestEmail: row.guestEmail,
      guestEmergencyContact: row.guestEmergencyContact,
    };
  }

  /** Route 52 — the feed's polling fallback and its reconnect catch-up. */
  async today(since: string | undefined, now: Date = new Date()): Promise<DeskTodayPayload> {
    const today = gymToday(now, this.gym.timeZone);
    const businessDate = toDateColumn(today);
    const sinceInstant = parseSince(since);
    const changedSince = sinceInstant === null ? {} : { updatedAt: { gt: sinceInstant } };

    const [arrivals, denials, stations, counters] = await Promise.all([
      this.prisma.checkIn.findMany({
        where: { businessDate, voidedAt: null, ...changedSince },
        include: MEMBER_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }],
        take: FEED_PAGE,
      }),
      this.prisma.checkInDenial.findMany({
        where: { businessDate, ...changedSince },
        include: MEMBER_INCLUDE,
        orderBy: [{ updatedAt: 'desc' }],
        take: FEED_PAGE,
      }),
      this.prisma.station.findMany({ orderBy: { name: 'asc' } }),
      this.counters(businessDate),
    ]);

    // The batch window in seconds: how long one minted batch keeps a display
    // painting. `live` allows two of them.
    const batchWindowSeconds = this.gym.stationTokenSlotSeconds * this.gym.stationTokenBatchSize;

    return {
      serverTime: now.toISOString(),
      cursor: cursorFrom(
        [...arrivals.map((r) => r.updatedAt), ...denials.map((r) => r.updatedAt)],
        sinceInstant ?? new Date(0),
      ),
      counters,
      arrivals: arrivals.map((row) =>
        toDeskArrival(
          { ...row, station: row.station },
          this.personOf(row.user, row.guestName, today),
        ),
      ),
      denials: denials.map((row) => {
        const verdict = this.verdictFor(row.user, today);
        return toDeskDenial(
          { ...row, station: row.station },
          this.deskMemberOf(row.user, today),
          verdict.message,
        );
      }),
      stations: stations.map((row) => toDeskStationStatus(row, now, batchWindowSeconds)),
    };
  }

  private async counters(businessDate: Date): Promise<DeskCounters> {
    const [inGym, today, needsYou, manualToday] = await this.prisma.$transaction([
      this.prisma.checkIn.count({ where: openVisitWhere(businessDate) }),
      this.prisma.checkIn.count({ where: { businessDate, voidedAt: null } }),
      this.prisma.checkInDenial.count({
        where: {
          businessDate,
          outcome: 'UNRESOLVED',
          // The funnel is a query, not a column — see SELLABLE_DENIAL_REASONS.
          reason: { in: [...SELLABLE_DENIAL_REASONS] },
        },
      }),
      this.prisma.checkIn.count({
        where: { businessDate, voidedAt: null, method: { in: ['MEMBER_CODE', 'MANUAL'] } },
      }),
    ]);

    return { inGym, today, needsYou, manualToday };
  }

  /**
   * The ladder, run over an already-loaded row.
   *
   * `dayPassValidToday: false` is a deliberate simplification on this READ
   * path and nowhere else: it can only ever make the desk's copy more
   * conservative ("sell them today" when they already paid), the staffer is
   * looking at the person, and the alternative is one extra query per row on a
   * board that refreshes every three seconds. The WRITE path resolves it
   * properly, inside its transaction, which is the only place the answer
   * changes an outcome.
   */
  private verdictFor(user: MemberRow, today: CivilDate): AccessResult {
    const membership = user.membership;
    return accessVerdict(
      {
        userStatus: user.status,
        membership:
          membership === null
            ? null
            : toMembershipSnapshot(membership, membership.holds[0] ?? null),
        dayPassValidToday: false,
      },
      today,
      {
        expiringSoonDays: this.gym.expiringSoonDays,
        graceAdmissionsMax: this.gym.graceAdmissionsMax,
      },
    );
  }

  /**
   * A `CheckIn` may have no `userId`: an off-the-street walk-in guest has no
   * account by design, and the board still has to show a name.
   */
  private personOf(user: MemberRow | null, guestName: string | null, today: CivilDate): DeskMember {
    return user === null ? toDeskGuest(guestName) : this.deskMemberOf(user, today);
  }

  private deskMemberOf(user: MemberRow, today: CivilDate): DeskMember {
    const membership = user.membership;
    const snapshot =
      membership === null ? null : toMembershipSnapshot(membership, membership.holds[0] ?? null);
    return toDeskMember(user, snapshot, this.verdictFor(user, today));
  }
}

/**
 * "Still inside the building" — the ONE predicate both the board
 * (`activeCheckIns`) and the in-gym counter use, so the two can never
 * disagree about who is in.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * A MEMBER is inside while their visit holds the open-visit sentinel. The
 * sentinel, not `endedAt: null`, is the definition — the two agree by
 * `CheckIn_open_marker_agrees`, and reading the unique-indexed one keeps the
 * query off a sequential scan as the table grows.
 *
 * A GUEST (an account-less walk-in) can never hold the sentinel: it is a
 * per-user marker and they have no user row (`CheckIn_open_marker`). The
 * board used to filter on the sentinel alone, so every walk-in guest was
 * invisible here, missing from the count, and could not be checked out from
 * anywhere. For them "open" is `endedAt IS NULL` — which the migration
 * `20260820140000_open_marker_exempts_account_less_guests` made legal — on
 * TODAY's business day. The day bound is deliberate: guest visits opened
 * before the closing-time job existed were never closed, and a guest from
 * last month is not in the building. That job now closes them nightly.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function openVisitWhere(businessDate: Date): Prisma.CheckInWhereInput {
  return {
    voidedAt: null,
    OR: [{ openUserId: { not: null } }, { userId: null, endedAt: null, businessDate }],
  };
}

/**
 * One include, used by every projection in this file. The `holds` filter reads
 * the nullable-unique sentinel, so `take: 1` is a statement of fact rather
 * than a truncation.
 */
const MEMBER_INCLUDE = {
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
} as const;

type MemberRow = Prisma.UserGetPayload<{
  select: {
    id: true;
    firstName: true;
    lastName: true;
    memberCode: true;
    avatarUrl: true;
    status: true;
    membership: { include: { holds: true } };
  };
}>;

/**
 * A hard cap on one feed page. The console renders a rail, not an archive, and
 * an unbounded `findMany` over a busy day's rows is a query that gets slower
 * every hour until 22:00 and then resets — the worst shape of slow, because it
 * is fastest exactly when anyone tests it.
 */
const FEED_PAGE = 200;

/**
 * A malformed `?since=` is IGNORED, not rejected.
 *
 * This value round-trips through a console that has been open since 06:00 and
 * may carry a cursor from a previous deploy. Answering a stale or garbled one
 * with a 400 blanks the desk board mid-shift; answering it with a full day's
 * payload costs one larger response and self-heals on the next poll.
 */
function parseSince(since: string | undefined): Date | null {
  if (since === undefined || since.length === 0) return null;
  const parsed = new Date(since);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
