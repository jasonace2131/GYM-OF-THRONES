import { HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DenialReason, MembershipStatus } from '@got/shared';
import { BookingsService } from './bookings.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { asCivilDate } from '../common/time/gym-time';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { MembershipService } from '../membership/membership.service';
import type { BookingSubject } from '../membership/booking-eligibility';
import type { MembershipSnapshot } from '../membership/access-verdict';
import type {
  MemberNoticeInput,
  MemberNoticesService,
} from '../notifications/member-notices.service';

/**
 * BookingsService against a small in-memory stand-in for the two tables.
 *
 * Not a jest.fn per call, on purpose. Every seat change is now several
 * statements inside one transaction — lock, read, take or free a seat, move a
 * waitlister, read back — and a script of mocked return values would test the
 * script. The fake keeps real rows instead, so each test asserts what a member
 * would see afterwards: who holds a seat, who is still waiting, what the
 * counter says. It is held to the database's own rules: the ten ClassBooking
 * CHECKs, `ClassSession_booked_within_capacity` and the booking-key unique
 * index all throw here as they would in Postgres, and a transaction that
 * throws is rolled back. Its log records the order of locks, reads, writes,
 * commits and notices, which is how "the lock comes first" and "notices only
 * after the commit" are asserted.
 *
 * The plan rules are B1's real `bookingEligibility`; only the loader is a
 * stand-in, keyed by member.
 */

const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_SESSION_ID = '33333333-3333-4333-8333-333333333334';
const COACH_ID = '11111111-1111-4111-8111-111111111111';
const DESK_ID = '66666666-6666-4666-8666-666666666666';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const memberId = (n: number): string => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

/** Wed 16 Sep 2026, 6:00 PM in Manila; an hour long. */
const STARTS_AT = new Date('2026-09-16T10:00:00.000Z');
const ENDS_AT = new Date('2026-09-16T11:00:00.000Z');
const minutes = (n: number): number => n * 60_000;
/** `n` minutes before the class starts. */
const beforeStart = (n: number): Date => new Date(STARTS_AT.getTime() - minutes(n));
/** Mon 14 Sep 2026, 10:00 AM in Manila — two gym days before the class. */
const NOW = new Date('2026-09-14T02:00:00.000Z');
/** A class day as its @db.Date column holds it. */
const dayColumn = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

// ── The member's plan, as MembershipService.loadBookingSubject returns it ────

function membership(over: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    status: MembershipStatus.ACTIVE,
    startsOn: asCivilDate('2026-09-01'),
    endsOn: asCivilDate('2026-12-31'),
    graceDays: 3,
    graceAdmissionsThisTerm: 0,
    cancelRequestedOn: null,
    planName: 'Monthly',
    planPriceCentavos: 80_000,
    hold: null,
    ...over,
  };
}

function plan(over: Partial<BookingSubject> = {}): BookingSubject {
  return {
    userStatus: 'ACTIVE',
    membership: membership(),
    scheduledHolds: [],
    planCode: 'MONTHLY',
    ...over,
  };
}

// ── The fake tables ──────────────────────────────────────────────────────────

type Status = 'BOOKED' | 'WAITLISTED' | 'CANCELLED' | 'ATTENDED' | 'NO_SHOW';

type SessionRec = {
  id: string;
  title: string;
  description: string | null;
  coachId: string;
  startsAt: Date;
  endsAt: Date;
  businessDate: Date;
  capacity: number;
  bookedCount: number;
  cancelledAt: Date | null;
  cancelReason: string | null;
};

type BookingRec = {
  id: string;
  sessionId: string;
  userId: string;
  status: Status;
  activeKey: string | null;
  bookedAt: Date;
  promotedAt: Date | null;
  cancelledAt: Date | null;
  attendedAt: Date | null;
  bookedById: string | null;
  cancelledById: string | null;
  removalReason: string | null;
  markedById: string | null;
  markedAt: Date | null;
};

type UserRec = {
  id: string;
  firstName: string;
  lastName: string;
  memberCode: string | null;
  role: string;
  deletedAt: Date | null;
};

type Row = Record<string, unknown>;

interface Args {
  where?: Row;
  data?: Row;
  orderBy?: unknown;
  take?: number;
  select?: Row;
  include?: Row;
}

const isRecord = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value);

function same(a: unknown, b: unknown): boolean {
  return a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;
}

function compare(a: unknown, b: unknown): number {
  const x = a instanceof Date ? a.getTime() : a;
  const y = b instanceof Date ? b.getTime() : b;
  if (typeof x === 'number' && typeof y === 'number') return x - y;
  return String(x) < String(y) ? -1 : String(x) > String(y) ? 1 : 0;
}

/** One column against one Prisma filter: a value, or { in, not, gt, gte, lt, lte }. */
function fieldMatches(value: unknown, filter: unknown): boolean {
  if (!isRecord(filter)) return same(value, filter);
  return Object.entries(filter).every(([op, arg]) => {
    switch (op) {
      case 'in':
        return (arg as unknown[]).some((option) => same(value, option));
      case 'not':
        return !same(value, arg);
      case 'gt':
        return compare(value, arg) > 0;
      case 'gte':
        return compare(value, arg) >= 0;
      case 'lt':
        return compare(value, arg) < 0;
      case 'lte':
        return compare(value, arg) <= 0;
      default:
        throw new Error(`fake: unsupported filter "${op}"`);
    }
  });
}

function rowMatches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([key, filter]) => fieldMatches(row[key], filter));
}

/** Prisma's `data`: plain values, or { increment } / { decrement } on a counter. */
function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (!isRecord(value)) {
      row[key] = value;
    } else if (typeof value['increment'] === 'number') {
      row[key] = (row[key] as number) + value['increment'];
    } else if (typeof value['decrement'] === 'number') {
      row[key] = (row[key] as number) - value['decrement'];
    } else {
      throw new Error(`fake: unsupported update of "${key}"`);
    }
  }
}

function violation(name: string): Error {
  return new Error(`new row violates check constraint "${name}"`);
}

function checkSession(s: SessionRec): void {
  if (s.bookedCount < 0 || s.bookedCount > s.capacity) {
    throw violation('ClassSession_booked_within_capacity');
  }
}

/** The ten ClassBooking CHECKs, in the name order Postgres tests them in. */
function checkBooking(b: BookingRec): void {
  const marked = b.status === 'ATTENDED' || b.status === 'NO_SHOW';
  const reason = b.removalReason?.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') ?? null;
  const rules: Array<[string, boolean]> = [
    [
      'ClassBooking_active_key_matches',
      b.activeKey === null || b.activeKey === `${b.sessionId}:${b.userId}`,
    ],
    ['ClassBooking_active_key_shape', (b.status !== 'CANCELLED') === (b.activeKey !== null)],
    ['ClassBooking_attended_shape', (b.status === 'ATTENDED') === (b.attendedAt !== null)],
    ['ClassBooking_booker_not_member', b.bookedById === null || b.bookedById !== b.userId],
    ['ClassBooking_cancelled_shape', (b.status === 'CANCELLED') === (b.cancelledAt !== null)],
    ['ClassBooking_canceller_not_member', b.cancelledById === null || b.cancelledById !== b.userId],
    ['ClassBooking_canceller_shape', b.cancelledById === null || b.status === 'CANCELLED'],
    ['ClassBooking_marked_shape', b.markedAt === null || marked],
    ['ClassBooking_marker_shape', b.markedById === null || b.markedAt !== null],
    [
      'ClassBooking_removal_reason_shape',
      reason === null ||
        (b.cancelledById !== null && [...reason].length >= 3 && [...reason].length <= 300),
    ],
  ];
  for (const [name, holds] of rules) if (!holds) throw violation(name);
}

/** What Prisma throws when an INSERT loses the booking key. */
function uniqueViolation(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields: (`activeKey`)',
    {
      code: 'P2002',
      clientVersion: '6.19.0',
      meta: { modelName: 'ClassBooking', target: ['activeKey'] },
    },
  );
}

class FakeClassDb {
  readonly sessions = new Map<string, SessionRec>();
  bookings: BookingRec[] = [];
  readonly users = new Map<string, UserRec>();
  /** lock:<id>, read:<op>, write:<op>, begin, commit, rollback — and notify, from the notices stub. */
  readonly log: string[] = [];
  readonly txOptions: unknown[] = [];
  /** The next booking INSERT loses the key, as it would to a writer that takes no lock. */
  raceOnCreate = false;
  /** The next statement with this name fails, to roll a transaction back mid-way. */
  breakOn: string | null = null;
  private seq = 0;
  private minute = 0;

  async $transaction<T>(work: (tx: FakeClassDb) => Promise<T>, options?: unknown): Promise<T> {
    this.txOptions.push(options);
    const saved = structuredClone({
      sessions: [...this.sessions.entries()],
      bookings: this.bookings,
    });
    this.log.push('begin');
    try {
      const result = await work(this);
      this.log.push('commit');
      return result;
    } catch (caught) {
      this.sessions.clear();
      for (const [id, rec] of saved.sessions) this.sessions.set(id, rec);
      this.bookings = saved.bookings;
      this.log.push('rollback');
      throw caught;
    }
  }

  $queryRaw(strings: TemplateStringsArray, ...values: unknown[]): Promise<Array<{ id: string }>> {
    const sql = strings.join('$?');
    if (!/FOR UPDATE/.test(sql) || !/"ClassSession"/.test(sql)) {
      return Promise.reject(new Error(`fake: unexpected SQL ${sql}`));
    }
    const id = String(values[0]);
    this.log.push(`lock:${id}`);
    return Promise.resolve(this.sessions.has(id) ? [{ id }] : []);
  }

  readonly classSession = {
    findUnique: jest.fn((args: Args) => {
      this.step('read', 'classSession.findUnique');
      return Promise.resolve(this.sessionRow(args));
    }),
    findUniqueOrThrow: jest.fn((args: Args) => {
      this.step('read', 'classSession.findUniqueOrThrow');
      const row = this.sessionRow(args);
      return row === null ? Promise.reject(new Error('fake: no such class')) : Promise.resolve(row);
    }),
    update: jest.fn((args: Args) => {
      this.step('write', 'classSession.update');
      const rec = this.session(String(args.where?.['id']));
      apply(rec, args.data ?? {});
      checkSession(rec);
      return Promise.resolve(this.sessionRow(args));
    }),
    updateMany: jest.fn((args: Args) => {
      this.step('write', 'classSession.updateMany');
      let count = 0;
      for (const rec of this.sessions.values()) {
        if (!rowMatches(rec, args.where ?? {})) continue;
        apply(rec, args.data ?? {});
        checkSession(rec);
        count += 1;
      }
      return Promise.resolve({ count });
    }),
  };

  readonly classBooking = {
    findUnique: jest.fn((args: Args) => {
      this.step('read', 'classBooking.findUnique');
      const rec = this.bookings.find((b) => rowMatches(b, args.where ?? {}));
      return Promise.resolve(rec === undefined ? null : this.bookingRow(rec));
    }),
    findUniqueOrThrow: jest.fn((args: Args) => {
      this.step('read', 'classBooking.findUniqueOrThrow');
      const rec = this.bookings.find((b) => rowMatches(b, args.where ?? {}));
      return rec === undefined
        ? Promise.reject(new Error('fake: no such booking'))
        : Promise.resolve(this.bookingRow(rec));
    }),
    findMany: jest.fn((args: Args) => {
      this.step('read', 'classBooking.findMany');
      const rows = this.sorted(
        this.bookings.filter((b) => this.bookingMatches(b, args.where ?? {})),
        args.orderBy,
      );
      return Promise.resolve(
        rows.slice(0, args.take ?? rows.length).map((b) => this.bookingRow(b)),
      );
    }),
    create: jest.fn((args: Args) => {
      this.step('write', 'classBooking.create');
      if (this.raceOnCreate) {
        this.raceOnCreate = false;
        throw uniqueViolation();
      }
      const rec: BookingRec = {
        id: this.nextId(),
        activeKey: null,
        promotedAt: null,
        cancelledAt: null,
        attendedAt: null,
        bookedById: null,
        cancelledById: null,
        removalReason: null,
        markedById: null,
        markedAt: null,
        ...(args.data as Pick<BookingRec, 'sessionId' | 'userId' | 'status' | 'bookedAt'>),
      };
      this.assertKeyFree(rec);
      checkBooking(rec);
      this.bookings.push(rec);
      return Promise.resolve(this.bookingRow(rec));
    }),
    update: jest.fn((args: Args) => {
      this.step('write', 'classBooking.update');
      const rec = this.bookings.find((b) => rowMatches(b, args.where ?? {}));
      if (rec === undefined) throw new Error('fake: no such booking');
      apply(rec, args.data ?? {});
      this.assertKeyFree(rec);
      checkBooking(rec);
      return Promise.resolve(this.bookingRow(rec));
    }),
    updateMany: jest.fn((args: Args) => {
      this.step('write', 'classBooking.updateMany');
      let count = 0;
      for (const rec of this.bookings) {
        if (!this.bookingMatches(rec, args.where ?? {})) continue;
        apply(rec, args.data ?? {});
        checkBooking(rec);
        count += 1;
      }
      return Promise.resolve({ count });
    }),
  };

  readonly user = {
    findFirst: jest.fn((args: Args) => {
      this.step('read', 'user.findFirst');
      const rec = [...this.users.values()].find((u) => rowMatches(u, args.where ?? {}));
      return Promise.resolve(rec ?? null);
    }),
  };

  // ── seeding ──

  addSession(over: Partial<SessionRec> = {}): SessionRec {
    const rec: SessionRec = {
      id: SESSION_ID,
      title: 'Yoga',
      description: null,
      coachId: COACH_ID,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      businessDate: dayColumn('2026-09-16'),
      capacity: 10,
      bookedCount: 0,
      cancelledAt: null,
      cancelReason: null,
      ...over,
    };
    this.sessions.set(rec.id, rec);
    return rec;
  }

  addUser(id: string, over: Partial<UserRec> = {}): UserRec {
    const rec: UserRec = {
      id,
      firstName: 'Member',
      lastName: id.slice(-2),
      memberCode: null,
      role: 'CLIENT',
      deletedAt: null,
      ...over,
    };
    this.users.set(id, rec);
    return rec;
  }

  /**
   * A booking as the service would have left it — joined a minute after the
   * one added before it — with any seat it holds counted on its class.
   */
  addBooking(userId: string, status: Status, over: Partial<BookingRec> = {}): BookingRec {
    const sessionId = over.sessionId ?? SESSION_ID;
    this.minute += 1;
    const rec: BookingRec = {
      id: this.nextId(),
      sessionId,
      userId,
      status,
      activeKey: status === 'CANCELLED' ? null : `${sessionId}:${userId}`,
      bookedAt: new Date(Date.UTC(2026, 8, 10, 0, this.minute)),
      promotedAt: null,
      cancelledAt: status === 'CANCELLED' ? new Date('2026-09-11T00:00:00.000Z') : null,
      attendedAt: status === 'ATTENDED' ? STARTS_AT : null,
      bookedById: null,
      cancelledById: null,
      removalReason: null,
      markedById: null,
      markedAt: null,
      ...over,
    };
    checkBooking(rec);
    this.bookings.push(rec);
    if (status === 'BOOKED' || status === 'ATTENDED' || status === 'NO_SHOW') {
      const session = this.session(sessionId);
      session.bookedCount += 1;
      checkSession(session);
    }
    return rec;
  }

  // ── reading back ──

  session(id: string): SessionRec {
    const rec = this.sessions.get(id);
    if (rec === undefined) throw new Error(`fake: no class ${id}`);
    return rec;
  }

  /** The member's live booking for a class, or their latest one. */
  bookingOf(userId: string, sessionId = SESSION_ID): BookingRec {
    const rows = this.bookings.filter((b) => b.userId === userId && b.sessionId === sessionId);
    const rec = rows.find((b) => b.status !== 'CANCELLED') ?? rows[rows.length - 1];
    if (rec === undefined) throw new Error(`fake: ${userId} has no booking`);
    return rec;
  }

  writes(): string[] {
    return this.log.filter((entry) => entry.startsWith('write:'));
  }

  // ── internals ──

  private step(kind: 'read' | 'write', op: string): void {
    this.log.push(`${kind}:${op}`);
    if (this.breakOn === op) {
      this.breakOn = null;
      throw new Error(`fake: ${op} failed`);
    }
  }

  private nextId(): string {
    this.seq += 1;
    return `bbbbbbbb-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
  }

  private assertKeyFree(rec: BookingRec): void {
    if (rec.activeKey === null) return;
    if (this.bookings.some((b) => b !== rec && b.activeKey === rec.activeKey)) {
      throw uniqueViolation();
    }
  }

  private nameOf(id: string): { firstName: string; lastName: string } {
    const user = this.users.get(id);
    return { firstName: user?.firstName ?? 'Unknown', lastName: user?.lastName ?? 'Person' };
  }

  private bookingMatches(b: BookingRec, where: Row): boolean {
    return Object.entries(where).every(([key, filter]) =>
      key === 'session'
        ? rowMatches(this.session(b.sessionId), filter as Row)
        : fieldMatches((b as Row)[key], filter),
    );
  }

  private sorted(rows: BookingRec[], orderBy: unknown): BookingRec[] {
    const keys = (
      Array.isArray(orderBy) ? orderBy : orderBy === undefined ? [] : [orderBy]
    ) as Row[];
    const value = (b: BookingRec, key: Row): [unknown, string] => {
      const [field, dir] = Object.entries(key)[0] as [string, unknown];
      if (isRecord(dir)) {
        const [inner, innerDir] = Object.entries(dir)[0] as [string, string];
        return [(this.session(b.sessionId) as Row)[inner], innerDir];
      }
      return [(b as Row)[field], String(dir)];
    };
    return [...rows].sort((a, b) => {
      for (const key of keys) {
        const [x, dir] = value(a, key);
        const [y] = value(b, key);
        const order = compare(x, y);
        if (order !== 0) return dir === 'desc' ? -order : order;
      }
      return 0;
    });
  }

  private sessionRow(args: Args): Row | null {
    const rec = this.sessions.get(String(args.where?.['id']));
    if (rec === undefined) return null;
    const row: Row = {
      ...rec,
      coach: this.nameOf(rec.coachId),
      _count: {
        bookings: this.bookings.filter((b) => b.sessionId === rec.id && b.status === 'WAITLISTED')
          .length,
      },
    };
    const nested = args.select?.['bookings'];
    if (isRecord(nested)) {
      const where = (nested['where'] as Row | undefined) ?? {};
      row['bookings'] = this.sorted(
        this.bookings.filter((b) => b.sessionId === rec.id && this.bookingMatches(b, where)),
        nested['orderBy'],
      ).map((b) => this.bookingRow(b));
    }
    return row;
  }

  private bookingRow(b: BookingRec): Row {
    const user = this.users.get(b.userId);
    return {
      ...b,
      session: this.sessionRow({ where: { id: b.sessionId } }),
      user: {
        firstName: user?.firstName ?? 'Member',
        lastName: user?.lastName ?? 'Fixture',
        memberCode: user?.memberCode ?? null,
      },
      markedBy: b.markedById === null ? null : this.nameOf(b.markedById),
    };
  }
}

/** MembershipService's two booking loaders, answering from a map of plans. */
class FakePlans {
  readonly subjects = new Map<string, BookingSubject>();
  readonly loadBookingSubject = jest.fn((userId: string) =>
    Promise.resolve(this.subjects.get(userId) ?? null),
  );
  readonly loadBookingSubjects = jest.fn((userIds: readonly string[]) => {
    const found = new Map<string, BookingSubject>();
    for (const id of userIds) {
      const subject = this.subjects.get(id);
      if (subject !== undefined) found.set(id, subject);
    }
    return Promise.resolve(found);
  });
}

function build(session: Partial<SessionRec> = {}) {
  const db = new FakeClassDb();
  const plans = new FakePlans();
  const sent: MemberNoticeInput[] = [];
  const notices = {
    notify: jest.fn((inputs: readonly MemberNoticeInput[]) => {
      db.log.push('notify');
      sent.push(...inputs);
      return Promise.resolve();
    }),
  };
  const service = new BookingsService(
    db as unknown as PrismaService,
    gym,
    plans as unknown as MembershipService,
    notices as unknown as MemberNoticesService,
  );
  db.addSession(session);
  db.addUser(COACH_ID, { firstName: 'Coach', lastName: 'Andrea', role: 'COACH' });
  db.addUser(DESK_ID, { firstName: 'Dana', lastName: 'Reyes', role: 'FRONT_DESK' });

  /** A member account, with the plan given (null: no live account to load). */
  const member = (n: number, subject: BookingSubject | null = plan()): string => {
    const id = memberId(n);
    db.addUser(id, { firstName: `Member${n}`, lastName: 'Cruz', memberCode: `GOT-${n}` });
    if (subject !== null) plans.subjects.set(id, subject);
    return id;
  };

  return { db, plans, notices, sent, service, member };
}

type Ctx = ReturnType<typeof build>;

/** The DomainException a call fails with; fails the test if it succeeds or throws anything else. */
async function refusal(work: Promise<unknown>): Promise<DomainException> {
  try {
    await work;
  } catch (caught) {
    if (caught instanceof DomainException) return caught;
    throw caught;
  }
  throw new Error('expected a DomainException, but the call succeeded');
}

/** A class that is full: `capacity` seats, every one booked. */
function fullClass(capacity = 1) {
  const ctx = build({ capacity });
  for (let n = 1; n <= capacity; n += 1) ctx.db.addBooking(ctx.member(100 + n), 'BOOKED');
  return ctx;
}

// ═════════════════════════════════════════════════════════════════════════════

describe('BookingsService.book — a member books a class', () => {
  it('locks the class before it reads or writes anything, in one 8-second transaction', async () => {
    const ctx = build();
    await ctx.service.book(ctx.member(1), SESSION_ID, NOW);

    expect(ctx.db.log.slice(0, 2)).toEqual(['begin', `lock:${SESSION_ID}`]);
    expect(ctx.db.txOptions).toEqual([{ timeout: 8_000 }]);
  });

  it('books a free seat: BOOKED, one seat counted, nobody else recorded on it', async () => {
    const ctx = build();
    const me = ctx.member(1);

    const result = await ctx.service.book(me, SESSION_ID, NOW);

    expect(result).toMatchObject({
      status: 'BOOKED',
      bookedAt: NOW.toISOString(),
      promotedAt: null,
      waitlistPosition: null,
      addedByStaff: false,
      cancelledBy: null,
    });
    expect(ctx.db.bookingOf(me)).toMatchObject({
      bookedById: null,
      activeKey: `${SESSION_ID}:${me}`,
    });
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);
  });

  it('answers with the class as it now stands — the seat taken, the queue counted', async () => {
    const ctx = fullClass(2);
    ctx.db.addBooking(ctx.member(3), 'WAITLISTED');

    const result = await ctx.service.book(ctx.member(4), SESSION_ID, NOW);

    expect(result.session).toMatchObject({
      bookedCount: 2,
      seatsLeft: 0,
      isFull: true,
      waitlistCount: 2,
    });
  });

  it('sends no notice — the member did it, and the answer says what happened', async () => {
    const ctx = build();
    await ctx.service.book(ctx.member(1), SESSION_ID, NOW);
    expect(ctx.notices.notify).not.toHaveBeenCalled();
  });

  describe('the class itself', () => {
    it('refuses a class that does not exist — CLASS_NOT_FOUND, 404', async () => {
      const ctx = build();
      const error = await refusal(ctx.service.book(ctx.member(1), UNKNOWN_ID, NOW));
      expect([error.code, error.getStatus()]).toEqual(['CLASS_NOT_FOUND', HttpStatus.NOT_FOUND]);
    });

    it('refuses a class the gym cancelled — CLASS_CANCELLED', async () => {
      const ctx = build({
        cancelledAt: new Date('2026-09-13T00:00:00.000Z'),
        cancelReason: 'Coach ill',
      });
      expect((await refusal(ctx.service.book(ctx.member(1), SESSION_ID, NOW))).code).toBe(
        'CLASS_CANCELLED',
      );
      expect(ctx.db.writes()).toEqual([]);
    });

    it('refuses a class that has started — CLASS_ALREADY_STARTED', async () => {
      const ctx = build();
      expect((await refusal(ctx.service.book(ctx.member(1), SESSION_ID, STARTS_AT))).code).toBe(
        'CLASS_ALREADY_STARTED',
      );
    });
  });

  /**
   * Owner, 2026-10-11: the plan must cover the CLASS DAY (Wed 16 Sep here;
   * today is Mon 14 Sep). Grace and day passes do not count. Each refusal is
   * member copy, takes no seat and joins no waitlist.
   */
  describe('the plan on the class day — BOOKING_PLAN_REQUIRED', () => {
    const cases: Array<[string, BookingSubject | null, DenialReason, string, string | null]> = [
      [
        'no plan at all',
        plan({ membership: null, planCode: null }),
        DenialReason.NO_MEMBERSHIP,
        'You need a plan to book classes. Choose one on your Subscription page or at the desk.',
        null,
      ],
      [
        'no live account behind the token (a race with a delete)',
        null,
        DenialReason.NO_MEMBERSHIP,
        'You need a plan to book classes. Choose one on your Subscription page or at the desk.',
        null,
      ],
      [
        'a plan that ends the day before the class',
        plan({ membership: membership({ endsOn: asCivilDate('2026-09-15') }) }),
        DenialReason.MEMBERSHIP_EXPIRED,
        'Your plan ends 15 Sep, before this class. Renew to book it.',
        '2026-09-15',
      ],
      [
        'a plan that has already ended — no past date is named',
        plan({ membership: membership({ endsOn: asCivilDate('2026-09-10') }) }),
        DenialReason.MEMBERSHIP_EXPIRED,
        'Your plan has ended. Renew to book classes.',
        null,
      ],
      [
        'a lapsed plan in its grace days — grace does not count',
        plan({
          membership: membership({
            status: MembershipStatus.EXPIRED,
            endsOn: asCivilDate('2026-09-13'),
          }),
        }),
        DenialReason.MEMBERSHIP_EXPIRED,
        'Your plan has ended. Renew to book classes.',
        null,
      ],
      [
        'notice given, and the last day comes before the class',
        plan({
          membership: membership({
            endsOn: asCivilDate('2026-09-15'),
            cancelRequestedOn: asCivilDate('2026-09-01'),
          }),
        }),
        DenialReason.MEMBERSHIP_CANCELLED,
        'Your plan ends 15 Sep, before this class. Start a new plan to book it.',
        '2026-09-15',
      ],
      [
        'frozen over the class day',
        plan({
          membership: membership({
            status: MembershipStatus.FROZEN,
            hold: { startsOn: asCivilDate('2026-09-10'), endsOn: asCivilDate('2026-09-20') },
          }),
        }),
        DenialReason.MEMBERSHIP_FROZEN,
        "Classes can't be booked during your plan's pause, which ends 20 Sep.",
        '2026-09-20',
      ],
      [
        // Not running yet (it starts tomorrow), so the copy must not say the
        // plan IS paused — only that the class falls in the pause.
        'a freeze booked over the class day, not yet begun',
        plan({
          scheduledHolds: [
            {
              startsOn: asCivilDate('2026-09-15'),
              endsOn: asCivilDate('2026-09-21'),
              daysRequested: 7,
            },
          ],
        }),
        DenialReason.MEMBERSHIP_FROZEN,
        "Classes can't be booked during your plan's pause, which ends 21 Sep.",
        '2026-09-21',
      ],
      [
        'a suspended account — the vague copy, no date',
        plan({ userStatus: 'SUSPENDED' }),
        DenialReason.ACCOUNT_SUSPENDED,
        "There's a note on your account. Please talk to the desk.",
        null,
      ],
    ];

    it.each(cases)(
      'refuses %s, takes no seat and joins no queue',
      async (_name, subject, reason, message, date) => {
        const ctx = build();
        const me = ctx.member(1, subject);

        const error = await refusal(ctx.service.book(me, SESSION_ID, NOW));

        expect(error.code).toBe('BOOKING_PLAN_REQUIRED');
        expect(error.getStatus()).toBe(HttpStatus.UNPROCESSABLE_ENTITY);
        expect(error.message).toBe(message);
        expect(error.details).toEqual({ reason, relevantDate: date });
        expect(ctx.db.writes()).toEqual([]);
        expect(ctx.db.bookings).toEqual([]);
      },
    );

    it('checks the plan before anything about the member’s place, so a full class is no different', async () => {
      const ctx = fullClass();
      const error = await refusal(
        ctx.service.book(ctx.member(1, plan({ membership: null })), SESSION_ID, NOW),
      );
      expect(error.code).toBe('BOOKING_PLAN_REQUIRED');
      expect(ctx.db.bookings.filter((b) => b.status === 'WAITLISTED')).toEqual([]);
    });

    it('reads the plan on the transaction that writes the seat', async () => {
      const ctx = build();
      const me = ctx.member(1);
      await ctx.service.book(me, SESSION_ID, NOW);
      expect(ctx.plans.loadBookingSubject).toHaveBeenCalledWith(me, ctx.db);
    });
  });

  /**
   * Owner, 2026-10-11: 14 gym days today included (last day = today + 13);
   * 21 on QUARTERLY and ANNUAL. Today is Mon 14 Sep in Manila.
   */
  describe('the booking window — BOOKING_WINDOW_NOT_OPEN', () => {
    function onDay(day: string, subject: BookingSubject = plan()) {
      const ctx = build({
        businessDate: dayColumn(day),
        startsAt: new Date(`${day}T10:00:00.000Z`),
        endsAt: new Date(`${day}T11:00:00.000Z`),
      });
      return { ctx, me: ctx.member(1, subject) };
    }

    it('books the last day of a 14-day window — today + 13', async () => {
      const { ctx, me } = onDay('2026-09-27');
      await expect(ctx.service.book(me, SESSION_ID, NOW)).resolves.toMatchObject({
        status: 'BOOKED',
      });
    });

    it('refuses the day after — today + 14 — naming the day booking opens', async () => {
      const { ctx, me } = onDay('2026-09-28');

      const error = await refusal(ctx.service.book(me, SESSION_ID, NOW));

      expect(error.code).toBe('BOOKING_WINDOW_NOT_OPEN');
      expect(error.message).toBe('Booking for this class opens on Tue 15 Sep.');
      expect(error.details).toEqual({ opensOn: '2026-09-15' });
      expect(ctx.db.writes()).toEqual([]);
    });

    it.each(['QUARTERLY', 'ANNUAL'])(
      'gives %s three weeks: today + 20 books, today + 21 does not',
      async (code) => {
        const last = onDay('2026-10-04', plan({ planCode: code }));
        await expect(last.ctx.service.book(last.me, SESSION_ID, NOW)).resolves.toMatchObject({
          status: 'BOOKED',
        });

        const beyond = onDay('2026-10-05', plan({ planCode: code }));
        const error = await refusal(beyond.ctx.service.book(beyond.me, SESSION_ID, NOW));
        expect(error.code).toBe('BOOKING_WINDOW_NOT_OPEN');
        expect(error.details).toEqual({ opensOn: '2026-09-15' });
      },
    );

    // 16:30 UTC on the 13th is 00:30 on the 14th in Manila: today + 13 is the
    // 27th. Counting from the UTC date would refuse it as today + 14.
    it('counts gym days, not UTC days', async () => {
      const { ctx, me } = onDay('2026-09-27');
      await expect(
        ctx.service.book(me, SESSION_ID, new Date('2026-09-13T16:30:00.000Z')),
      ).resolves.toMatchObject({ status: 'BOOKED' });
    });

    it('applies to joining a waitlist too', async () => {
      const { ctx, me } = onDay('2026-09-28');
      ctx.db.session(SESSION_ID).capacity = 1;
      ctx.db.addBooking(ctx.member(2), 'BOOKED');
      expect((await refusal(ctx.service.book(me, SESSION_ID, NOW))).code).toBe(
        'BOOKING_WINDOW_NOT_OPEN',
      );
    });
  });

  describe('a member who already holds a place', () => {
    it('refuses a member who already has a seat — ALREADY_BOOKED, 409', async () => {
      const ctx = build();
      const me = ctx.member(1);
      ctx.db.addBooking(me, 'BOOKED');

      const error = await refusal(ctx.service.book(me, SESSION_ID, NOW));

      expect([error.code, error.getStatus(), error.message]).toEqual([
        'ALREADY_BOOKED',
        HttpStatus.CONFLICT,
        'You already have a place in this class.',
      ]);
      expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);
    });

    // The key survives the register (2026-09-09): marked present is still "in".
    it('refuses a member the register already marked, and claims no seat', async () => {
      const ctx = build();
      const me = ctx.member(1);
      ctx.db.addBooking(me, 'ATTENDED');

      const error = await refusal(ctx.service.book(me, SESSION_ID, beforeStart(10)));

      expect(error.message).toBe('You were already registered for this class.');
      expect(ctx.db.writes()).toEqual([]);
    });

    it('refuses a waitlister while the class is still full', async () => {
      const ctx = fullClass();
      const me = ctx.member(1);
      ctx.db.addBooking(me, 'WAITLISTED');

      const error = await refusal(ctx.service.book(me, SESSION_ID, NOW));

      expect([error.code, error.getStatus(), error.message]).toEqual([
        'ALREADY_BOOKED',
        HttpStatus.CONFLICT,
        "This class is full, so you're still on its waitlist.",
      ]);
      expect(ctx.db.writes()).toEqual([]);
    });

    // 'Take the free place' tapped too late: somebody else booked the seat
    // first. After the cutoff the queue no longer moves, so the answer says
    // waiting will not bring the next freed place by itself.
    it.each([
      [121, "This class is full, so you're still on its waitlist."],
      [
        120,
        "Someone else took that place first. You're still on the waitlist, but it has closed, so a place now goes to whoever books it first.",
      ],
      [
        30,
        "Someone else took that place first. You're still on the waitlist, but it has closed, so a place now goes to whoever books it first.",
      ],
    ])(
      '%i minutes before the start, a waitlister who finds the class full is told so — still ALREADY_BOOKED, 409',
      async (lead, message) => {
        const ctx = fullClass();
        const me = ctx.member(1);
        ctx.db.addBooking(me, 'WAITLISTED');

        const error = await refusal(ctx.service.book(me, SESSION_ID, beforeStart(lead)));

        expect([error.code, error.getStatus(), error.message]).toEqual([
          'ALREADY_BOOKED',
          HttpStatus.CONFLICT,
          message,
        ]);
        expect(ctx.db.bookingOf(me).status).toBe('WAITLISTED');
        expect(ctx.db.writes()).toEqual([]);
      },
    );

    // After the cutoff nobody is promoted, so this is how a waitlister gets a
    // seat freed by a late cancellation: they take it themselves.
    it('lets a waitlister take a seat that came free — their own row, promotedAt left null', async () => {
      const ctx = build({ capacity: 2 });
      ctx.db.addBooking(ctx.member(2), 'BOOKED');
      const me = ctx.member(1);
      const mine = ctx.db.addBooking(me, 'WAITLISTED');

      const result = await ctx.service.book(me, SESSION_ID, beforeStart(60));

      expect(result).toMatchObject({ bookingId: mine.id, status: 'BOOKED', promotedAt: null });
      expect(ctx.db.bookings.filter((b) => b.userId === me)).toHaveLength(1);
      expect(ctx.db.session(SESSION_ID).bookedCount).toBe(2);
      expect(result.session.waitlistCount).toBe(0);
    });
  });

  describe('a full class, and the waitlist cutoff (120 minutes before the start)', () => {
    it('puts the member on the waitlist and says where in the queue', async () => {
      const ctx = fullClass();
      ctx.db.addBooking(ctx.member(2), 'WAITLISTED');
      const me = ctx.member(1);

      const result = await ctx.service.book(me, SESSION_ID, NOW);

      expect(result).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 2 });
      expect(result.session.waitlistCount).toBe(2);
      expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);
    });

    it.each([
      [121, 'WAITLISTED'],
      [120, 'WAITLIST_CLOSED'],
      [119, 'WAITLIST_CLOSED'],
    ])('%i minutes before the start: %s', async (lead, outcome) => {
      const ctx = fullClass();
      const work = ctx.service.book(ctx.member(1), SESSION_ID, beforeStart(lead));

      if (outcome === 'WAITLISTED') {
        await expect(work).resolves.toMatchObject({ status: 'WAITLISTED', waitlistPosition: 1 });
      } else {
        expect((await refusal(work)).code).toBe('WAITLIST_CLOSED');
        expect(ctx.db.bookings.filter((b) => b.status === 'WAITLISTED')).toEqual([]);
      }
    });

    it('tells the member when the waitlist closed, and how a freed seat is now given out', async () => {
      const ctx = fullClass();
      const error = await refusal(ctx.service.book(ctx.member(1), SESSION_ID, beforeStart(30)));
      expect(error.message).toBe(
        'This class is full, and its waitlist closed at 4:00 PM. If a place frees up, it goes to whoever books it first.',
      );
    });
  });

  it('turns a lost race on the booking key into ALREADY_BOOKED, and keeps no seat', async () => {
    const ctx = build();
    ctx.db.raceOnCreate = true;

    const error = await refusal(ctx.service.book(ctx.member(1), SESSION_ID, NOW));

    expect([error.code, error.getStatus()]).toEqual(['ALREADY_BOOKED', HttpStatus.CONFLICT]);
    expect(ctx.db.log).toContain('rollback');
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('BookingsService.cancel — a member gives up a place', () => {
  it('cancels and frees the seat, recording nobody as the canceller', async () => {
    const ctx = build();
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'BOOKED');

    const result = await ctx.service.cancel(me, SESSION_ID, NOW);

    expect(result).toMatchObject({
      status: 'CANCELLED',
      cancelledBy: 'MEMBER',
      removalReason: null,
    });
    expect(ctx.db.bookingOf(me)).toMatchObject({
      status: 'CANCELLED',
      activeKey: null,
      cancelledAt: NOW,
      cancelledById: null,
      removalReason: null,
    });
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(0);
    expect(result.session.bookedCount).toBe(0);
    expect(ctx.notices.notify).not.toHaveBeenCalled();
  });

  it('hands the seat to the first person waiting, and tells them after the commit', async () => {
    const ctx = build({ capacity: 1 });
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'BOOKED');
    const first = ctx.member(2);
    const second = ctx.member(3);
    const promoted = ctx.db.addBooking(first, 'WAITLISTED');
    ctx.db.addBooking(second, 'WAITLISTED');

    const result = await ctx.service.cancel(me, SESSION_ID, NOW);

    expect(ctx.db.bookingOf(first)).toMatchObject({ status: 'BOOKED', promotedAt: NOW });
    expect(ctx.db.bookingOf(second).status).toBe('WAITLISTED');
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);
    // The answer is read after the promotion: still full, one fewer waiting.
    expect(result.session).toMatchObject({ bookedCount: 1, waitlistCount: 1 });

    expect(ctx.sent).toEqual([
      {
        userId: first,
        kind: 'CLASS_PROMOTED',
        title: "You're in: Yoga, Wed 16 Sep 6:00 PM",
        body: "A place opened up and it's yours. Can't make it? Cancel so the next person gets it.",
        linkPath: '/portal/book?date=2026-09-16',
        subjectType: 'ClassBooking',
        subjectId: promoted.id,
        dedupeKey: `CLASS_PROMOTED:${promoted.id}:${NOW.getTime()}`,
      },
    ]);
    expect(ctx.db.log.indexOf('notify')).toBeGreaterThan(ctx.db.log.indexOf('commit'));
  });

  it('skips a waitlister whose plan does not cover the class day — they stay waiting, untold', async () => {
    const ctx = build({ capacity: 1 });
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'BOOKED');
    const lapsed = ctx.member(
      2,
      plan({ membership: membership({ endsOn: asCivilDate('2026-09-15') }) }),
    );
    const next = ctx.member(3);
    ctx.db.addBooking(lapsed, 'WAITLISTED');
    ctx.db.addBooking(next, 'WAITLISTED');

    await ctx.service.cancel(me, SESSION_ID, NOW);

    expect(ctx.db.bookingOf(lapsed)).toMatchObject({ status: 'WAITLISTED', promotedAt: null });
    expect(ctx.db.bookingOf(next).status).toBe('BOOKED');
    expect(ctx.sent.map((notice) => notice.userId)).toEqual([next]);
  });

  // Owner: "the desk can still add someone by hand". The add skipped the plan
  // check, and that has to hold when the queue reaches them.
  it('promotes a waitlister the desk added, plan or no plan, and tells them', async () => {
    const ctx = build({ capacity: 1 });
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'BOOKED');
    const added = ctx.member(2, plan({ membership: null, planCode: null }));
    const behind = ctx.member(3);
    const place = ctx.db.addBooking(added, 'WAITLISTED', { bookedById: DESK_ID });
    ctx.db.addBooking(behind, 'WAITLISTED');

    await ctx.service.cancel(me, SESSION_ID, NOW);

    expect(ctx.db.bookingOf(added)).toMatchObject({ status: 'BOOKED', promotedAt: NOW });
    expect(ctx.db.bookingOf(behind).status).toBe('WAITLISTED');
    expect(ctx.sent).toEqual([
      expect.objectContaining({
        userId: added,
        kind: 'CLASS_PROMOTED',
        subjectId: place.id,
      }),
    ]);
  });

  it('skips a waitlister with no live account, and judges the whole queue in one load', async () => {
    const ctx = build({ capacity: 1 });
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'BOOKED');
    const gone = ctx.member(2, null);
    const next = ctx.member(3);
    ctx.db.addBooking(gone, 'WAITLISTED');
    ctx.db.addBooking(next, 'WAITLISTED');

    await ctx.service.cancel(me, SESSION_ID, NOW);

    expect(ctx.db.bookingOf(gone).status).toBe('WAITLISTED');
    expect(ctx.db.bookingOf(next).status).toBe('BOOKED');
    expect(ctx.plans.loadBookingSubjects).toHaveBeenCalledTimes(1);
    expect(ctx.plans.loadBookingSubjects).toHaveBeenCalledWith([gone, next], ctx.db);
  });

  // bookedAt is millisecond precision, and the showcase seed gives a whole
  // class one instant: the id is what makes the queue a total order.
  it('serves the queue by joining time, the booking id breaking a tie', async () => {
    const ctx = build({ capacity: 1 });
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'BOOKED');
    const tie = new Date('2026-09-12T00:00:00.000Z');
    const later = ctx.member(2);
    const earlier = ctx.member(3);
    ctx.db.addBooking(later, 'WAITLISTED', {
      id: 'bbbbbbbb-0000-4000-8000-0000000000f2',
      bookedAt: tie,
    });
    ctx.db.addBooking(earlier, 'WAITLISTED', {
      id: 'bbbbbbbb-0000-4000-8000-0000000000f1',
      bookedAt: tie,
    });

    await ctx.service.cancel(me, SESSION_ID, NOW);

    expect(ctx.db.bookingOf(earlier).status).toBe('BOOKED');
    expect(ctx.db.bookingOf(later).status).toBe('WAITLISTED');
  });

  it.each([
    [121, true],
    [120, false],
    [119, false],
  ])(
    '%i minutes before the start, the freed seat goes to the queue: %s',
    async (lead, promotes) => {
      const ctx = build({ capacity: 1 });
      const me = ctx.member(1);
      ctx.db.addBooking(me, 'BOOKED');
      const waiting = ctx.member(2);
      ctx.db.addBooking(waiting, 'WAITLISTED');

      await ctx.service.cancel(me, SESSION_ID, beforeStart(lead));

      expect(ctx.db.bookingOf(waiting).status).toBe(promotes ? 'BOOKED' : 'WAITLISTED');
      // After the cutoff the seat is simply free, for whoever books it first.
      expect(ctx.db.session(SESSION_ID).bookedCount).toBe(promotes ? 1 : 0);
      expect(ctx.sent).toHaveLength(promotes ? 1 : 0);
    },
  );

  it('frees no seat, and promotes nobody, when a waitlister leaves', async () => {
    const ctx = fullClass();
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'WAITLISTED');
    const behind = ctx.member(2);
    ctx.db.addBooking(behind, 'WAITLISTED');

    await ctx.service.cancel(me, SESSION_ID, NOW);

    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);
    expect(ctx.db.bookingOf(behind).status).toBe('WAITLISTED');
  });

  describe('refusals', () => {
    it('refuses a member with no place — BOOKING_NOT_FOUND, 404', async () => {
      const ctx = build();
      const error = await refusal(ctx.service.cancel(ctx.member(1), SESSION_ID, NOW));
      expect([error.code, error.getStatus()]).toEqual(['BOOKING_NOT_FOUND', HttpStatus.NOT_FOUND]);
    });

    it('refuses a booking the register has marked — BOOKING_NOT_CANCELLABLE', async () => {
      const ctx = build();
      const me = ctx.member(1);
      ctx.db.addBooking(me, 'NO_SHOW');
      expect((await refusal(ctx.service.cancel(me, SESSION_ID, NOW))).code).toBe(
        'BOOKING_NOT_CANCELLABLE',
      );
      expect(ctx.db.writes()).toEqual([]);
    });

    // F16: promoting somebody into a cancelled class would tell them they are
    // in a class that is not running, and change the "affected" count.
    it('refuses on a class the gym cancelled — CLASS_CANCELLED — promoting nobody', async () => {
      const ctx = build({ capacity: 1 });
      const me = ctx.member(1);
      ctx.db.addBooking(me, 'BOOKED');
      const waiting = ctx.member(2);
      ctx.db.addBooking(waiting, 'WAITLISTED');
      Object.assign(ctx.db.session(SESSION_ID), {
        cancelledAt: new Date('2026-09-13T00:00:00.000Z'),
        cancelReason: 'Coach ill',
      });

      expect((await refusal(ctx.service.cancel(me, SESSION_ID, NOW))).code).toBe('CLASS_CANCELLED');
      expect(ctx.db.bookingOf(waiting).status).toBe('WAITLISTED');
      expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);
      expect(ctx.db.writes()).toEqual([]);
    });

    it('refuses once the class has started — CLASS_ALREADY_STARTED', async () => {
      const ctx = build();
      const me = ctx.member(1);
      ctx.db.addBooking(me, 'BOOKED');
      expect((await refusal(ctx.service.cancel(me, SESSION_ID, STARTS_AT))).code).toBe(
        'CLASS_ALREADY_STARTED',
      );
    });

    it('allows cancelling one minute before the start', async () => {
      const ctx = build();
      const me = ctx.member(1);
      ctx.db.addBooking(me, 'BOOKED');
      await expect(ctx.service.cancel(me, SESSION_ID, beforeStart(1))).resolves.toMatchObject({
        status: 'CANCELLED',
      });
    });
  });

  it('tells nobody, and changes nothing, when the transaction fails after the promotion', async () => {
    const ctx = build({ capacity: 1 });
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'BOOKED');
    const waiting = ctx.member(2);
    ctx.db.addBooking(waiting, 'WAITLISTED');
    // The promotion has moved the waitlister; reading the answer back fails.
    ctx.db.breakOn = 'classBooking.findUniqueOrThrow';

    await expect(ctx.service.cancel(me, SESSION_ID, NOW)).rejects.toThrow('failed');

    expect(ctx.notices.notify).not.toHaveBeenCalled();
    expect(ctx.db.bookingOf(me).status).toBe('BOOKED');
    expect(ctx.db.bookingOf(waiting).status).toBe('WAITLISTED');
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('BookingsService.fillFromWaitlist — free seats to the queue', () => {
  /** Runs the fill the way a caller does: on its own transaction, after its own write. */
  const fill = (ctx: ReturnType<typeof build>, now = NOW) =>
    ctx.db.$transaction((tx) =>
      ctx.service.fillFromWaitlist(tx as unknown as Prisma.TransactionClient, SESSION_ID, now),
    );

  // A capacity raise, as ClassesService.update writes it before filling.
  it('promotes min(waiting, new seats), in queue order, counting each seat once', async () => {
    const ctx = fullClass(2);
    const queue = [ctx.member(1), ctx.member(2), ctx.member(3)];
    for (const id of queue) ctx.db.addBooking(id, 'WAITLISTED');
    ctx.db.session(SESSION_ID).capacity = 4;

    const promoted = await fill(ctx);

    expect(promoted.map((place) => place.userId)).toEqual([queue[0], queue[1]]);
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(4);
    expect(ctx.db.bookingOf(queue[2]).status).toBe('WAITLISTED');
  });

  it('promotes everybody waiting when there are more new seats than people', async () => {
    const ctx = fullClass(2);
    const queue = [ctx.member(1), ctx.member(2)];
    for (const id of queue) ctx.db.addBooking(id, 'WAITLISTED');
    ctx.db.session(SESSION_ID).capacity = 5;

    const promoted = await fill(ctx);

    expect(promoted.map((place) => place.userId)).toEqual(queue);
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(4);
  });

  it('passes over an ineligible person for every seat, not just the first', async () => {
    const ctx = fullClass(1);
    const lapsed = ctx.member(1, plan({ userStatus: 'SUSPENDED' }));
    const a = ctx.member(2);
    const b = ctx.member(3);
    for (const id of [lapsed, a, b]) ctx.db.addBooking(id, 'WAITLISTED');
    ctx.db.session(SESSION_ID).capacity = 3;

    const promoted = await fill(ctx);

    expect(promoted.map((place) => place.userId)).toEqual([a, b]);
    expect(ctx.db.bookingOf(lapsed).status).toBe('WAITLISTED');
  });

  // The desk's add skipped the plan check; a member's own join did not, and
  // still has to pass it when a seat frees.
  it('promotes an ineligible waitlister the desk added, and still skips one who joined themselves', async () => {
    const ctx = fullClass(1);
    const lapsed = (): BookingSubject =>
      plan({ membership: membership({ endsOn: asCivilDate('2026-09-15') }) });
    const selfJoined = ctx.member(1, lapsed());
    const deskAdded = ctx.member(2, lapsed());
    const next = ctx.member(3);
    const last = ctx.member(4);
    ctx.db.addBooking(selfJoined, 'WAITLISTED');
    ctx.db.addBooking(deskAdded, 'WAITLISTED', { bookedById: DESK_ID });
    ctx.db.addBooking(next, 'WAITLISTED');
    ctx.db.addBooking(last, 'WAITLISTED');
    ctx.db.session(SESSION_ID).capacity = 3;

    const promoted = await fill(ctx);

    expect(promoted.map((place) => place.userId)).toEqual([deskAdded, next]);
    expect(ctx.db.bookingOf(selfJoined)).toMatchObject({ status: 'WAITLISTED', promotedAt: null });
    expect(ctx.db.bookingOf(last).status).toBe('WAITLISTED');
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(3);
  });

  // A deleted account has nobody to give a seat to, whoever added it.
  it('skips a desk-added waitlister with no live account', async () => {
    const ctx = fullClass(1);
    const gone = ctx.member(1, null);
    const next = ctx.member(2);
    ctx.db.addBooking(gone, 'WAITLISTED', { bookedById: DESK_ID });
    ctx.db.addBooking(next, 'WAITLISTED');
    ctx.db.session(SESSION_ID).capacity = 2;

    const promoted = await fill(ctx);

    expect(promoted.map((place) => place.userId)).toEqual([next]);
    expect(ctx.db.bookingOf(gone).status).toBe('WAITLISTED');
  });

  it('does nothing for a cancelled class, after the cutoff, or with no seat free', async () => {
    const cancelled = fullClass(1);
    cancelled.db.addBooking(cancelled.member(1), 'WAITLISTED');
    Object.assign(cancelled.db.session(SESSION_ID), {
      capacity: 2,
      cancelledAt: new Date('2026-09-13T00:00:00.000Z'),
      cancelReason: 'Coach ill',
    });
    await expect(fill(cancelled)).resolves.toEqual([]);

    const late = fullClass(1);
    late.db.addBooking(late.member(1), 'WAITLISTED');
    late.db.session(SESSION_ID).capacity = 2;
    await expect(fill(late, beforeStart(120))).resolves.toEqual([]);
    await expect(fill(late, STARTS_AT)).resolves.toEqual([]);

    const full = fullClass(1);
    full.db.addBooking(full.member(1), 'WAITLISTED');
    await expect(fill(full)).resolves.toEqual([]);
    expect(full.db.writes()).toEqual([]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('BookingsService.addByStaff — the desk adds a member by hand', () => {
  it('books a free seat, records who added them, and tells the member after the commit', async () => {
    const ctx = build();
    const member = ctx.member(1);

    const entry = await ctx.service.addByStaff(DESK_ID, SESSION_ID, member, NOW);

    expect(entry).toMatchObject({
      status: 'BOOKED',
      addedByStaff: true,
      waitlistPosition: null,
      member: { firstName: 'Member1', lastName: 'Cruz', memberCode: 'GOT-1' },
    });
    expect(ctx.db.bookingOf(member)).toMatchObject({ bookedById: DESK_ID, promotedAt: null });
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);
    expect(ctx.sent).toEqual([
      {
        userId: member,
        kind: 'BOOKING_ADDED',
        title: 'Booked by the desk: Yoga, Wed 16 Sep 6:00 PM',
        body: "The desk booked you a place. Can't make it? Cancel so someone else can have it.",
        linkPath: '/portal/book?date=2026-09-16',
        subjectType: 'ClassBooking',
        subjectId: entry.bookingId,
        dedupeKey: `BOOKING_ADDED:${entry.bookingId}:BOOKED`,
      },
    ]);
    expect(ctx.db.log.indexOf('notify')).toBeGreaterThan(ctx.db.log.indexOf('commit'));
  });

  // Owner, 2026-10-11: the desk can add by hand — capacity still applies.
  it('ignores the plan and the booking window', async () => {
    const ctx = build({
      businessDate: dayColumn('2026-10-30'),
      startsAt: new Date('2026-10-30T10:00:00.000Z'),
      endsAt: new Date('2026-10-30T11:00:00.000Z'),
    });
    const lapsed = ctx.member(1, plan({ membership: null }));

    await expect(ctx.service.addByStaff(DESK_ID, SESSION_ID, lapsed, NOW)).resolves.toMatchObject({
      status: 'BOOKED',
    });
    expect(ctx.plans.loadBookingSubject).not.toHaveBeenCalled();
  });

  it('puts them on a full class’s waitlist before the cutoff, with their place', async () => {
    const ctx = fullClass();
    ctx.db.addBooking(ctx.member(2), 'WAITLISTED');
    const member = ctx.member(1);

    const entry = await ctx.service.addByStaff(DESK_ID, SESSION_ID, member, NOW);

    expect(entry).toMatchObject({ status: 'WAITLISTED', waitlistPosition: 2, addedByStaff: true });
    expect(ctx.db.bookingOf(member).bookedById).toBe(DESK_ID);
    expect(ctx.sent[0]).toMatchObject({
      kind: 'BOOKING_ADDED',
      title: 'The desk put you on the waitlist (#2): Yoga, Wed 16 Sep 6:00 PM',
      dedupeKey: `BOOKING_ADDED:${entry.bookingId}:WAITLISTED`,
    });
    expect(ctx.sent[0]?.body).toContain('4:00 PM');
  });

  it.each([
    ['once the waitlist has closed', beforeStart(120)],
    ['while the class is running', new Date(STARTS_AT.getTime() + minutes(10))],
  ])('refuses a full class %s — WAITLIST_CLOSED: raise the places', async (_name, now) => {
    const ctx = fullClass();
    const error = await refusal(ctx.service.addByStaff(DESK_ID, SESSION_ID, ctx.member(1), now));

    expect(error.code).toBe('WAITLIST_CLOSED');
    expect(error.message).toBe(
      'This class is full and its waitlist has closed. Raise the places to add Member1 Cruz.',
    );
    expect(ctx.notices.notify).not.toHaveBeenCalled();
  });

  // A member's cancel is refused once the class has started, so the walk-in's
  // notice must not tell them to cancel.
  it('lets a walk-in join a running class that has a seat free, with no advice to cancel', async () => {
    const ctx = build();
    await expect(
      ctx.service.addByStaff(
        DESK_ID,
        SESSION_ID,
        ctx.member(1),
        new Date(STARTS_AT.getTime() + minutes(10)),
      ),
    ).resolves.toMatchObject({ status: 'BOOKED' });
    expect(ctx.sent).toEqual([
      expect.objectContaining({
        kind: 'BOOKING_ADDED',
        title: 'Booked by the desk: Yoga, Wed 16 Sep 6:00 PM',
        body: 'The desk booked you a place in this class.',
      }),
    ]);
  });

  it('refuses a class that has finished — CLASS_FINISHED', async () => {
    const ctx = build();
    expect(
      (await refusal(ctx.service.addByStaff(DESK_ID, SESSION_ID, ctx.member(1), ENDS_AT))).code,
    ).toBe('CLASS_FINISHED');
  });

  it('refuses a cancelled class and an unknown one', async () => {
    const cancelled = build({
      cancelledAt: new Date('2026-09-13T00:00:00.000Z'),
      cancelReason: 'Coach ill',
    });
    expect(
      (await refusal(cancelled.service.addByStaff(DESK_ID, SESSION_ID, cancelled.member(1), NOW)))
        .code,
    ).toBe('CLASS_CANCELLED');

    const ctx = build();
    const error = await refusal(ctx.service.addByStaff(DESK_ID, UNKNOWN_ID, ctx.member(1), NOW));
    expect([error.code, error.getStatus()]).toEqual(['CLASS_NOT_FOUND', HttpStatus.NOT_FOUND]);
  });

  describe('MEMBER_NOT_BOOKABLE — only a live member account', () => {
    const targets: Array<[string, (ctx: Ctx) => string]> = [
      ['an account that does not exist', () => UNKNOWN_ID],
      [
        'a deleted account',
        (ctx) => {
          const id = ctx.member(1);
          ctx.db.addUser(id, { deletedAt: new Date('2026-09-01T00:00:00.000Z') });
          return id;
        },
      ],
      ['a staff account', () => COACH_ID],
      ['the person adding', () => DESK_ID],
    ];

    it.each(targets)('refuses %s, before touching the class', async (_name, target) => {
      const ctx = build();
      const error = await refusal(ctx.service.addByStaff(DESK_ID, SESSION_ID, target(ctx), NOW));

      expect(error.code).toBe('MEMBER_NOT_BOOKABLE');
      expect(ctx.db.log).not.toContain(`lock:${SESSION_ID}`);
      expect(ctx.db.bookings).toEqual([]);
    });
  });

  describe('a member who already holds a place', () => {
    it('moves a waitlisted member into a free seat — promotedAt now, their own row', async () => {
      const ctx = build({ capacity: 2 });
      ctx.db.addBooking(ctx.member(2), 'BOOKED');
      const member = ctx.member(1);
      const waiting = ctx.db.addBooking(member, 'WAITLISTED');

      const entry = await ctx.service.addByStaff(DESK_ID, SESSION_ID, member, beforeStart(30));

      expect(entry).toMatchObject({ bookingId: waiting.id, status: 'BOOKED', addedByStaff: false });
      expect(ctx.db.bookingOf(member)).toMatchObject({
        status: 'BOOKED',
        promotedAt: beforeStart(30),
      });
      expect(ctx.db.session(SESSION_ID).bookedCount).toBe(2);
      expect(ctx.sent[0]).toMatchObject({
        kind: 'BOOKING_ADDED',
        dedupeKey: `BOOKING_ADDED:${waiting.id}:BOOKED`,
      });
    });

    // A desk add to the waitlist and a later move into a seat are two events on
    // one booking; one key for both would swallow "you're in".
    it('keys the waitlist add and the later move to a seat apart', async () => {
      const ctx = fullClass();
      const member = ctx.member(1);
      await ctx.service.addByStaff(DESK_ID, SESSION_ID, member, NOW);
      ctx.db.session(SESSION_ID).capacity = 2;
      await ctx.service.addByStaff(DESK_ID, SESSION_ID, member, beforeStart(60));

      const keys = ctx.sent.map((notice) => notice.dedupeKey);
      expect(new Set(keys).size).toBe(2);
    });

    it('refuses somebody already seated, or marked, naming them — ALREADY_BOOKED', async () => {
      const ctx = build();
      const seated = ctx.member(1);
      ctx.db.addBooking(seated, 'BOOKED');
      const seen = ctx.member(2);
      ctx.db.addBooking(seen, 'ATTENDED');

      const first = await refusal(
        ctx.service.addByStaff(DESK_ID, SESSION_ID, seated, beforeStart(10)),
      );
      const second = await refusal(
        ctx.service.addByStaff(DESK_ID, SESSION_ID, seen, beforeStart(10)),
      );

      expect([first.code, first.getStatus(), first.message]).toEqual([
        'ALREADY_BOOKED',
        HttpStatus.CONFLICT,
        'Member1 Cruz already has a place in this class.',
      ]);
      expect(second.message).toBe('Member2 Cruz was already registered for this class.');
    });

    it('refuses somebody already waiting while the class is still full', async () => {
      const ctx = fullClass();
      const member = ctx.member(1);
      ctx.db.addBooking(member, 'WAITLISTED');

      const error = await refusal(ctx.service.addByStaff(DESK_ID, SESSION_ID, member, NOW));

      expect(error.message).toBe('Member1 Cruz is already on the waitlist for this class.');
    });
  });

  it('turns a lost race on the booking key into ALREADY_BOOKED naming the member', async () => {
    const ctx = build();
    ctx.db.raceOnCreate = true;

    const error = await refusal(ctx.service.addByStaff(DESK_ID, SESSION_ID, ctx.member(1), NOW));

    expect([error.code, error.message]).toEqual([
      'ALREADY_BOOKED',
      'Member1 Cruz already has a place in this class.',
    ]);
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(0);
    expect(ctx.notices.notify).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('BookingsService.removeByStaff — the desk takes a member out', () => {
  it('cancels with who and why, hands the seat on, and tells both members after the commit', async () => {
    const ctx = build({ capacity: 1 });
    const member = ctx.member(1);
    const removed = ctx.db.addBooking(member, 'BOOKED');
    const next = ctx.member(2);
    const promoted = ctx.db.addBooking(next, 'WAITLISTED');

    const entry = await ctx.service.removeByStaff(
      DESK_ID,
      removed.id,
      '  Class moved to the small studio  ',
      NOW,
    );

    expect(entry).toMatchObject({ bookingId: removed.id, status: 'CANCELLED' });
    expect(ctx.db.bookingOf(member)).toMatchObject({
      status: 'CANCELLED',
      activeKey: null,
      cancelledAt: NOW,
      cancelledById: DESK_ID,
      removalReason: 'Class moved to the small studio',
    });
    expect(ctx.db.bookingOf(next)).toMatchObject({ status: 'BOOKED', promotedAt: NOW });
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);

    expect(ctx.sent).toEqual([
      {
        userId: member,
        kind: 'BOOKING_REMOVED',
        title: 'Removed from Yoga, Wed 16 Sep 6:00 PM',
        body: 'Class moved to the small studio',
        linkPath: '/portal/book?date=2026-09-16',
        subjectType: 'ClassBooking',
        subjectId: removed.id,
        dedupeKey: `BOOKING_REMOVED:${removed.id}`,
      },
      expect.objectContaining({ userId: next, kind: 'CLASS_PROMOTED', subjectId: promoted.id }),
    ]);
    expect(ctx.db.log.indexOf('notify')).toBeGreaterThan(ctx.db.log.indexOf('commit'));
  });

  it('shows the member who removed them and why, in their own history', async () => {
    const ctx = build();
    const member = ctx.member(1);
    const removed = ctx.db.addBooking(member, 'BOOKED');
    await ctx.service.removeByStaff(DESK_ID, removed.id, 'Double-booked by mistake', NOW);

    const [mine] = await ctx.service.mine(member, {}, NOW);

    expect(mine).toMatchObject({ cancelledBy: 'GYM', removalReason: 'Double-booked by mistake' });
  });

  it('frees no seat when the person removed was only waiting', async () => {
    const ctx = fullClass();
    const member = ctx.member(1);
    const waiting = ctx.db.addBooking(member, 'WAITLISTED');

    await ctx.service.removeByStaff(DESK_ID, waiting.id, 'Not a member any more', NOW);

    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(1);
    expect(ctx.sent.map((notice) => notice.kind)).toEqual(['BOOKING_REMOVED']);
  });

  it('after the cutoff, frees the seat for whoever books it first', async () => {
    const ctx = build({ capacity: 1 });
    const removed = ctx.db.addBooking(ctx.member(1), 'BOOKED');
    const waiting = ctx.member(2);
    ctx.db.addBooking(waiting, 'WAITLISTED');

    await ctx.service.removeByStaff(DESK_ID, removed.id, 'Unpaid', beforeStart(60));

    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(0);
    expect(ctx.db.bookingOf(waiting).status).toBe('WAITLISTED');
  });

  describe('refusals', () => {
    it('refuses an unknown booking — BOOKING_NOT_FOUND, 404', async () => {
      const ctx = build();
      const error = await refusal(ctx.service.removeByStaff(DESK_ID, UNKNOWN_ID, 'Unpaid', NOW));
      expect([error.code, error.getStatus()]).toEqual(['BOOKING_NOT_FOUND', HttpStatus.NOT_FOUND]);
    });

    it('refuses a booking already cancelled — BOOKING_CANCELLED', async () => {
      const ctx = build();
      const gone = ctx.db.addBooking(ctx.member(1), 'CANCELLED');
      expect((await refusal(ctx.service.removeByStaff(DESK_ID, gone.id, 'Unpaid', NOW))).code).toBe(
        'BOOKING_CANCELLED',
      );
    });

    it('refuses a booking the register has marked — BOOKING_NOT_CANCELLABLE', async () => {
      const ctx = build();
      const marked = ctx.db.addBooking(ctx.member(1), 'ATTENDED');
      expect(
        (await refusal(ctx.service.removeByStaff(DESK_ID, marked.id, 'Unpaid', beforeStart(10))))
          .code,
      ).toBe('BOOKING_NOT_CANCELLABLE');
    });

    it('refuses on a class the gym cancelled — CLASS_CANCELLED', async () => {
      const ctx = build();
      const booked = ctx.db.addBooking(ctx.member(1), 'BOOKED');
      Object.assign(ctx.db.session(SESSION_ID), {
        cancelledAt: new Date('2026-09-13T00:00:00.000Z'),
        cancelReason: 'Coach ill',
      });
      expect(
        (await refusal(ctx.service.removeByStaff(DESK_ID, booked.id, 'Unpaid', NOW))).code,
      ).toBe('CLASS_CANCELLED');
    });

    it('refuses once the class has started, pointing at the register instead', async () => {
      const ctx = build();
      const booked = ctx.db.addBooking(ctx.member(1), 'BOOKED');

      const error = await refusal(
        ctx.service.removeByStaff(DESK_ID, booked.id, 'Unpaid', STARTS_AT),
      );

      expect(error.code).toBe('CLASS_ALREADY_STARTED');
      expect(error.message).toContain('Mark them as a no-show instead.');
      expect(ctx.db.writes()).toEqual([]);
    });
  });

  // Somebody who booked as a member and has since joined the staff.
  it('records an account removing its own booking as its own cancellation, and sends it no notice', async () => {
    const ctx = build();
    const own = ctx.db.addBooking(DESK_ID, 'BOOKED');

    await ctx.service.removeByStaff(DESK_ID, own.id, 'Changed my mind', NOW);

    expect(ctx.db.bookingOf(DESK_ID)).toMatchObject({
      status: 'CANCELLED',
      cancelledById: null,
      removalReason: null,
    });
    expect(ctx.notices.notify).not.toHaveBeenCalled();
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('BookingsService.markAttendance — the register, with its marker', () => {
  const opens = beforeStart(30);

  // Both outcomes: `attendedAt` alone could never say who marked a no-show, or when.
  it.each([
    [true, 'ATTENDED'],
    [false, 'NO_SHOW'],
  ] as const)(
    'attended=%s writes %s with who and when, and answers with both',
    async (attended, status) => {
      const ctx = build();
      const booking = ctx.db.addBooking(ctx.member(1), 'BOOKED');
      const now = new Date(STARTS_AT.getTime() + minutes(5));

      const result = await ctx.service.markAttendance(COACH_ID, booking.id, attended, now);

      expect(result).toEqual({
        bookingId: booking.id,
        status,
        markedAt: now.toISOString(),
        markedBy: { firstName: 'Coach', lastName: 'Andrea' },
      });
      expect(ctx.db.bookingOf(booking.userId)).toMatchObject({
        status,
        markedById: COACH_ID,
        markedAt: now,
        attendedAt: attended ? now : null,
      });
    },
  );

  it('keeps activeKey, so a member who was marked still holds the class', async () => {
    const ctx = build();
    const booking = ctx.db.addBooking(ctx.member(1), 'BOOKED');
    await ctx.service.markAttendance(COACH_ID, booking.id, false, opens);
    expect(ctx.db.bookingOf(booking.userId).activeKey).toBe(`${SESSION_ID}:${booking.userId}`);
  });

  it('locks the class before it writes the mark', async () => {
    const ctx = build();
    const booking = ctx.db.addBooking(ctx.member(1), 'BOOKED');
    await ctx.service.markAttendance(COACH_ID, booking.id, true, opens);

    const lock = ctx.db.log.indexOf(`lock:${SESSION_ID}`);
    expect(lock).toBeGreaterThan(-1);
    expect(ctx.db.log.indexOf('write:classBooking.update')).toBeGreaterThan(lock);
  });

  // A missed register can be fixed later (owner default, 2026-10-11), and the
  // last marker wins.
  it('marks a class days later, and a correction overwrites the marker', async () => {
    const ctx = build();
    const booking = ctx.db.addBooking(ctx.member(1), 'BOOKED');
    await ctx.service.markAttendance(COACH_ID, booking.id, false, opens);

    const later = new Date('2026-09-19T03:00:00.000Z');
    const result = await ctx.service.markAttendance(DESK_ID, booking.id, true, later);

    expect(result).toMatchObject({
      status: 'ATTENDED',
      markedBy: { firstName: 'Dana', lastName: 'Reyes' },
    });
    expect(ctx.db.bookingOf(booking.userId)).toMatchObject({
      markedById: DESK_ID,
      markedAt: later,
    });
  });

  describe('when the register is open', () => {
    it('refuses 31 minutes before the start — CLASS_NOT_STARTED, naming the time in Manila', async () => {
      const ctx = build();
      const booking = ctx.db.addBooking(ctx.member(1), 'BOOKED');

      const error = await refusal(
        ctx.service.markAttendance(COACH_ID, booking.id, true, beforeStart(31)),
      );

      expect([error.code, error.message]).toEqual([
        'CLASS_NOT_STARTED',
        'The register opens at 5:30 PM.',
      ]);
      expect(ctx.db.writes()).toEqual([]);
    });

    it('allows exactly 30 minutes before the start', async () => {
      const ctx = build();
      const booking = ctx.db.addBooking(ctx.member(1), 'BOOKED');
      await expect(
        ctx.service.markAttendance(COACH_ID, booking.id, true, opens),
      ).resolves.toMatchObject({
        status: 'ATTENDED',
      });
    });
  });

  describe('refusals', () => {
    it('refuses an unknown booking — BOOKING_NOT_FOUND, 404', async () => {
      const ctx = build();
      const error = await refusal(ctx.service.markAttendance(COACH_ID, UNKNOWN_ID, true, opens));
      expect([error.code, error.getStatus()]).toEqual(['BOOKING_NOT_FOUND', HttpStatus.NOT_FOUND]);
    });

    it('refuses a cancelled booking — BOOKING_CANCELLED', async () => {
      const ctx = build();
      const booking = ctx.db.addBooking(ctx.member(1), 'CANCELLED');
      expect(
        (await refusal(ctx.service.markAttendance(COACH_ID, booking.id, true, opens))).code,
      ).toBe('BOOKING_CANCELLED');
    });

    it('refuses a class the gym cancelled — CLASS_CANCELLED', async () => {
      const ctx = build();
      const booking = ctx.db.addBooking(ctx.member(1), 'BOOKED');
      Object.assign(ctx.db.session(SESSION_ID), {
        cancelledAt: new Date('2026-09-15T00:00:00.000Z'),
        cancelReason: 'Coach ill',
      });
      expect(
        (await refusal(ctx.service.markAttendance(COACH_ID, booking.id, true, opens))).code,
      ).toBe('CLASS_CANCELLED');
    });

    it('refuses a waitlisted place — BOOKING_NOT_CONFIRMED', async () => {
      const ctx = fullClass();
      const booking = ctx.db.addBooking(ctx.member(1), 'WAITLISTED');
      expect(
        (await refusal(ctx.service.markAttendance(COACH_ID, booking.id, true, opens))).code,
      ).toBe('BOOKING_NOT_CONFIRMED');
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('BookingsService.mine — the member’s own bookings', () => {
  it('queries 60 gym days either side of today, every status, soonest first', async () => {
    const ctx = build();
    // 2026-09-09 20:45 in Manila.
    await ctx.service.mine(memberId(1), {}, new Date('2026-09-09T12:45:00.000Z'));

    const args = ctx.db.classBooking.findMany.mock.calls[0]?.[0];
    expect(args?.where).toEqual({
      userId: memberId(1),
      session: {
        businessDate: {
          gte: new Date('2026-07-11T00:00:00.000Z'),
          lte: new Date('2026-11-08T00:00:00.000Z'),
        },
      },
    });
    expect(args?.orderBy).toEqual({ session: { startsAt: 'asc' } });
    expect(args?.take).toBe(500);
  });

  it('numbers each waitlisted booking in its own class’s queue, from ONE extra query', async () => {
    const ctx = fullClass();
    ctx.db.addSession({
      id: OTHER_SESSION_ID,
      startsAt: new Date('2026-09-17T10:00:00.000Z'),
      endsAt: new Date('2026-09-17T11:00:00.000Z'),
      businessDate: dayColumn('2026-09-17'),
      capacity: 1,
    });
    ctx.db.addBooking(ctx.member(2), 'BOOKED', { sessionId: OTHER_SESSION_ID });
    const me = ctx.member(1);
    ctx.db.addBooking(ctx.member(3), 'WAITLISTED');
    ctx.db.addBooking(me, 'WAITLISTED');
    ctx.db.addBooking(me, 'WAITLISTED', { sessionId: OTHER_SESSION_ID });

    const rows = await ctx.service.mine(me, {}, NOW);

    expect(rows.map((row) => [row.session.id, row.waitlistPosition])).toEqual([
      [SESSION_ID, 2],
      [OTHER_SESSION_ID, 1],
    ]);
    expect(ctx.db.classBooking.findMany).toHaveBeenCalledTimes(2);
  });

  it('gives no place once the waitlist has closed — a number would promise a seat', async () => {
    const ctx = fullClass();
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'WAITLISTED');

    const [row] = await ctx.service.mine(me, {}, beforeStart(120));

    expect(row).toMatchObject({ status: 'WAITLISTED', waitlistPosition: null });
    expect(ctx.db.classBooking.findMany).toHaveBeenCalledTimes(1);
  });

  it('says a place was added by the desk', async () => {
    const ctx = build();
    const me = ctx.member(1);
    ctx.db.addBooking(me, 'BOOKED', { bookedById: DESK_ID });
    const [row] = await ctx.service.mine(me, {}, NOW);
    expect(row?.addedByStaff).toBe(true);
  });

  it('refuses a reversed window', async () => {
    const ctx = build();
    expect(
      (await refusal(ctx.service.mine(memberId(1), { from: '2026-09-20', to: '2026-09-01' }))).code,
    ).toBe('DATE_RANGE_INVALID');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('BookingsService.register — who is in a class', () => {
  it('lists seated and marked rows first in booking order, then the waitlist numbered', async () => {
    const ctx = build({ capacity: 3 });
    const booked = ctx.db.addBooking(ctx.member(1), 'BOOKED');
    const firstWaiting = ctx.db.addBooking(ctx.member(2), 'WAITLISTED');
    const attended = ctx.db.addBooking(ctx.member(3), 'ATTENDED', {
      markedById: COACH_ID,
      markedAt: STARTS_AT,
    });
    ctx.db.addBooking(ctx.member(4), 'CANCELLED');
    const secondWaiting = ctx.db.addBooking(ctx.member(5), 'WAITLISTED');
    const noShow = ctx.db.addBooking(ctx.member(6), 'NO_SHOW');

    const rows = await ctx.service.register(SESSION_ID);

    // Marked members stay where they booked — no longer sinking below the
    // people still waiting, as an enum-ordered sort made them.
    expect(rows.map((row) => [row.bookingId, row.status, row.waitlistPosition])).toEqual([
      [booked.id, 'BOOKED', null],
      [attended.id, 'ATTENDED', null],
      [noShow.id, 'NO_SHOW', null],
      [firstWaiting.id, 'WAITLISTED', 1],
      [secondWaiting.id, 'WAITLISTED', 2],
    ]);
    expect(rows[1]).toMatchObject({
      markedAt: STARTS_AT.toISOString(),
      markedBy: { firstName: 'Coach', lastName: 'Andrea' },
      member: { firstName: 'Member3', lastName: 'Cruz', memberCode: 'GOT-3' },
    });
  });

  it('answers 404 for a class that does not exist, rather than an empty register', async () => {
    const ctx = build();
    const error = await refusal(ctx.service.register(UNKNOWN_ID));
    expect([error.code, error.getStatus()]).toEqual(['CLASS_NOT_FOUND', HttpStatus.NOT_FOUND]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('BookingsService.bookingWindow — GET /me/booking-window', () => {
  const window = async (subject: BookingSubject | null) => {
    const ctx = build();
    return ctx.service.bookingWindow(ctx.member(1, subject), NOW);
  };

  it('gives a standard plan 14 days, today included', async () => {
    await expect(window(plan())).resolves.toEqual({
      windowDays: 14,
      lastBookableDay: '2026-09-27',
      eligibleToday: true,
      reason: null,
      message: null,
      planCoversUntil: '2026-12-31',
    });
  });

  it.each(['QUARTERLY', 'ANNUAL'])('gives %s 21 days', async (code) => {
    await expect(window(plan({ planCode: code }))).resolves.toMatchObject({
      windowDays: 21,
      lastBookableDay: '2026-10-04',
    });
  });

  it('projects the plan’s cover through a freeze already booked', async () => {
    const result = await window(
      plan({
        scheduledHolds: [
          {
            startsOn: asCivilDate('2026-10-01'),
            endsOn: asCivilDate('2026-10-14'),
            daysRequested: 14,
          },
        ],
      }),
    );
    expect(result.planCoversUntil).toBe('2027-01-14');
  });

  it('says why a member without a plan cannot book', async () => {
    await expect(window(plan({ membership: null, planCode: null }))).resolves.toEqual({
      windowDays: 14,
      lastBookableDay: '2026-09-27',
      eligibleToday: false,
      reason: DenialReason.NO_MEMBERSHIP,
      message:
        'You need a plan to book classes. Choose one on your Subscription page or at the desk.',
      planCoversUntil: null,
    });
  });

  // The priority window is a perk of a plan that still covers a day.
  it('gives a lapsed priority plan the standard window, and no cover date', async () => {
    const result = await window(
      plan({
        planCode: 'ANNUAL',
        membership: membership({
          status: MembershipStatus.EXPIRED,
          endsOn: asCivilDate('2026-09-10'),
        }),
      }),
    );
    expect(result).toEqual({
      windowDays: 14,
      lastBookableDay: '2026-09-27',
      eligibleToday: false,
      reason: DenialReason.MEMBERSHIP_EXPIRED,
      message: 'Your plan has ended. Renew to book classes.',
      planCoversUntil: null,
    });
  });

  // An ACTIVE row the nightly job has not expired yet still reports its end
  // date; behind today, that is not a day the plan covers.
  it('drops a cover date that is already behind today', async () => {
    const result = await window(
      plan({
        planCode: 'QUARTERLY',
        membership: membership({ endsOn: asCivilDate('2026-09-10') }),
      }),
    );
    expect(result).toMatchObject({ windowDays: 14, eligibleToday: false, planCoversUntil: null });
  });

  it('keeps a frozen member’s priority window, and says when the pause ends', async () => {
    const result = await window(
      plan({
        planCode: 'QUARTERLY',
        membership: membership({
          status: MembershipStatus.FROZEN,
          hold: { startsOn: asCivilDate('2026-09-10'), endsOn: asCivilDate('2026-09-20') },
        }),
      }),
    );
    expect(result).toEqual({
      windowDays: 21,
      lastBookableDay: '2026-10-04',
      eligibleToday: false,
      reason: DenialReason.MEMBERSHIP_FROZEN,
      message: "Classes can't be booked during your plan's pause, which ends 20 Sep.",
      planCoversUntil: '2026-12-31',
    });
  });

  it('reads a missing account as no plan', async () => {
    await expect(window(null)).resolves.toMatchObject({
      eligibleToday: false,
      reason: DenialReason.NO_MEMBERSHIP,
      planCoversUntil: null,
    });
  });
});
