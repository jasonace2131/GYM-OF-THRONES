import { HttpStatus } from '@nestjs/common';
import { MembershipStatus } from '@got/shared';
import { ClassesService } from './classes.service';
import { BookingsService } from './bookings.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { asCivilDate } from '../common/time/gym-time';
import type { PrismaService } from '../prisma/prisma.service';
import type { GymConfigService } from '../config/gym.config';
import type { MembershipService } from '../membership/membership.service';
import type { BookingSubject } from '../membership/booking-eligibility';
import type {
  MemberNoticeInput,
  MemberNoticesService,
} from '../notifications/member-notices.service';
import type { UpdateClassSessionDto } from './dto/class-session.dto';

/**
 * ClassesService — the timetable's edits and cancellations, now under the same
 * class lock as every seat change, with the waitlist filled after a capacity
 * raise and the members holding places told after the commit.
 *
 * Runs a REAL BookingsService over the same in-memory tables, so "raising the
 * places promotes the queue" is tested end to end rather than as "it called a
 * mock". Its own small stand-in for the tables, as house style has every spec
 * build its own: it keeps rows, enforces the capacity CHECK, rolls a failed
 * transaction back, and logs locks, writes, commits and notices in order.
 */

const gym = { timeZone: 'Asia/Manila' } as unknown as GymConfigService;

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const COACH_ID = '11111111-1111-4111-8111-111111111111';
const NEW_COACH_ID = '11111111-1111-4111-8111-111111111112';
const ADMIN_ID = '77777777-7777-4777-8777-777777777777';
const CLIENT_ID = '88888888-8888-4888-8888-888888888888';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const memberId = (n: number): string => `44444444-4444-4444-8444-${String(n).padStart(12, '0')}`;

/** Wed 16 Sep 2026, 6:00–7:00 PM in Manila. */
const STARTS_AT = new Date('2026-09-16T10:00:00.000Z');
const ENDS_AT = new Date('2026-09-16T11:00:00.000Z');
const minutes = (n: number): number => n * 60_000;
const beforeStart = (n: number): Date => new Date(STARTS_AT.getTime() - minutes(n));
/** Mon 14 Sep 2026, 10:00 AM in Manila. */
const NOW = new Date('2026-09-14T02:00:00.000Z');
/** When an early register mark was made: 25 minutes before the start, once the register opened. */
const MARKED_AT = beforeStart(25);

function plan(over: Partial<BookingSubject> = {}): BookingSubject {
  return {
    userStatus: 'ACTIVE',
    membership: {
      status: MembershipStatus.ACTIVE,
      startsOn: asCivilDate('2026-09-01'),
      endsOn: asCivilDate('2026-12-31'),
      graceDays: 3,
      graceAdmissionsThisTerm: 0,
      cancelRequestedOn: null,
      planName: 'Monthly',
      planPriceCentavos: 80_000,
      hold: null,
    },
    scheduledHolds: [],
    planCode: 'MONTHLY',
    ...over,
  };
}

// ── The stand-in tables ───────────────────────────────────────────────────

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
  createdById: string;
};

type BookingRec = {
  id: string;
  sessionId: string;
  userId: string;
  status: Status;
  bookedAt: Date;
  promotedAt: Date | null;
  attendedAt: Date | null;
  bookedById: string | null;
  markedAt: Date | null;
  markedById: string | null;
};

type UserRec = {
  id: string;
  firstName: string;
  lastName: string;
  role: string;
  deletedAt: Date | null;
};

type Row = Record<string, unknown>;

interface Args {
  where?: Row;
  data?: Row;
  include?: Row;
  select?: Row;
  orderBy?: unknown;
  take?: number;
}

const isRecord = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value);

const same = (a: unknown, b: unknown): boolean =>
  a instanceof Date && b instanceof Date ? a.getTime() === b.getTime() : a === b;

const ordinal = (value: unknown): number | string =>
  value instanceof Date ? value.getTime() : typeof value === 'number' ? value : String(value);

function fieldMatches(value: unknown, filter: unknown): boolean {
  if (!isRecord(filter)) return same(value, filter);
  return Object.entries(filter).every(([op, arg]) => {
    if (op === 'in') return (arg as unknown[]).some((option) => same(value, option));
    if (op === 'not') return !same(value, arg);
    if (op === 'gte') return ordinal(value) >= ordinal(arg);
    if (op === 'lte') return ordinal(value) <= ordinal(arg);
    throw new Error(`fake: unsupported filter "${op}"`);
  });
}

const rowMatches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, filter]) => fieldMatches(row[key], filter));

function apply(row: Row, data: Row): void {
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (isRecord(value) && typeof value['increment'] === 'number') {
      row[key] = (row[key] as number) + value['increment'];
    } else if (isRecord(value) && typeof value['decrement'] === 'number') {
      row[key] = (row[key] as number) - value['decrement'];
    } else {
      row[key] = value;
    }
  }
}

function checkSession(s: SessionRec): void {
  if (s.bookedCount < 0 || s.bookedCount > s.capacity) {
    throw new Error('new row violates check constraint "ClassSession_booked_within_capacity"');
  }
}

/** The ClassBooking CHECKs a register mark touches, as Postgres would enforce them. */
function checkBooking(b: BookingRec): void {
  const marked = b.status === 'ATTENDED' || b.status === 'NO_SHOW';
  const rules: Array<[string, boolean]> = [
    ['ClassBooking_attended_shape', (b.status === 'ATTENDED') === (b.attendedAt !== null)],
    ['ClassBooking_marked_shape', b.markedAt === null || marked],
    ['ClassBooking_marker_shape', b.markedById === null || b.markedAt !== null],
  ];
  for (const [name, holds] of rules) {
    if (!holds) throw new Error(`new row violates check constraint "${name}"`);
  }
}

class FakeTimetable {
  readonly sessions = new Map<string, SessionRec>();
  bookings: BookingRec[] = [];
  readonly users = new Map<string, UserRec>();
  readonly log: string[] = [];
  readonly txOptions: unknown[] = [];
  breakOn: string | null = null;
  private seq = 0;

  async $transaction<T>(work: (tx: FakeTimetable) => Promise<T>, options?: unknown): Promise<T> {
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
    if (!/FOR UPDATE/.test(strings.join('?')))
      return Promise.reject(new Error('fake: unexpected SQL'));
    const id = String(values[0]);
    this.log.push(`lock:${id}`);
    return Promise.resolve(this.sessions.has(id) ? [{ id }] : []);
  }

  readonly classSession = {
    findUnique: jest.fn((args: Args) => {
      this.step('read', 'classSession.findUnique');
      return Promise.resolve(this.sessionRow(String(args.where?.['id'])));
    }),
    findUniqueOrThrow: jest.fn((args: Args) => {
      this.step('read', 'classSession.findUniqueOrThrow');
      const row = this.sessionRow(String(args.where?.['id']));
      return row === null ? Promise.reject(new Error('fake: no such class')) : Promise.resolve(row);
    }),
    findMany: jest.fn((args: Args) => {
      this.step('read', 'classSession.findMany');
      const rows = [...this.sessions.values()]
        .filter((s) => rowMatches(s, args.where ?? {}))
        .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
        .slice(0, args.take);
      return Promise.resolve(rows.map((s) => this.sessionRow(s.id)));
    }),
    create: jest.fn((args: Args) => {
      this.step('write', 'classSession.create');
      this.seq += 1;
      const rec = {
        id: `cccccccc-0000-4000-8000-${String(this.seq).padStart(12, '0')}`,
        bookedCount: 0,
        cancelledAt: null,
        cancelReason: null,
        ...args.data,
      } as SessionRec;
      this.sessions.set(rec.id, rec);
      return Promise.resolve(this.sessionRow(rec.id));
    }),
    update: jest.fn((args: Args) => {
      this.step('write', 'classSession.update');
      const rec = this.session(String(args.where?.['id']));
      apply(rec, args.data ?? {});
      checkSession(rec);
      return Promise.resolve(this.sessionRow(rec.id));
    }),
  };

  readonly classBooking = {
    findMany: jest.fn((args: Args) => {
      this.step('read', 'classBooking.findMany');
      const rows = this.bookings
        .filter((b) => rowMatches(b, args.where ?? {}))
        .sort((a, b) => a.bookedAt.getTime() - b.bookedAt.getTime() || (a.id < b.id ? -1 : 1));
      return Promise.resolve(rows.map((b) => ({ ...b })));
    }),
    updateMany: jest.fn((args: Args) => {
      this.step('write', 'classBooking.updateMany');
      let count = 0;
      for (const rec of this.bookings) {
        if (!rowMatches(rec, args.where ?? {})) continue;
        apply(rec, args.data ?? {});
        checkBooking(rec);
        count += 1;
      }
      return Promise.resolve({ count });
    }),
  };

  readonly user = {
    findUnique: jest.fn((args: Args) => {
      this.step('read', 'user.findUnique');
      return Promise.resolve(this.users.get(String(args.where?.['id'])) ?? null);
    }),
  };

  addSession(over: Partial<SessionRec> = {}): SessionRec {
    const rec: SessionRec = {
      id: SESSION_ID,
      title: 'Spin',
      description: null,
      coachId: COACH_ID,
      startsAt: STARTS_AT,
      endsAt: ENDS_AT,
      businessDate: new Date('2026-09-16T00:00:00.000Z'),
      capacity: 2,
      bookedCount: 0,
      cancelledAt: null,
      cancelReason: null,
      createdById: ADMIN_ID,
      ...over,
    };
    this.sessions.set(rec.id, rec);
    return rec;
  }

  addUser(id: string, firstName: string, lastName: string, role: string): void {
    this.users.set(id, { id, firstName, lastName, role, deletedAt: null });
  }

  /**
   * A place in the class, joined a minute after the last; a seat it holds is
   * counted. A marked one carries its mark as the register writes it.
   */
  addBooking(userId: string, status: Status): BookingRec {
    this.seq += 1;
    const marked = status === 'ATTENDED' || status === 'NO_SHOW';
    const rec: BookingRec = {
      id: `bbbbbbbb-0000-4000-8000-${String(this.seq).padStart(12, '0')}`,
      sessionId: SESSION_ID,
      userId,
      status,
      bookedAt: new Date(Date.UTC(2026, 8, 10, 0, this.seq)),
      promotedAt: null,
      attendedAt: status === 'ATTENDED' ? MARKED_AT : null,
      bookedById: null,
      markedAt: marked ? MARKED_AT : null,
      markedById: marked ? COACH_ID : null,
    };
    checkBooking(rec);
    this.bookings.push(rec);
    if (status === 'BOOKED' || status === 'ATTENDED' || status === 'NO_SHOW') {
      const session = this.session(SESSION_ID);
      session.bookedCount += 1;
      checkSession(session);
    }
    return rec;
  }

  session(id: string): SessionRec {
    const rec = this.sessions.get(id);
    if (rec === undefined) throw new Error(`fake: no class ${id}`);
    return rec;
  }

  statusOf(userId: string): Status | undefined {
    return this.bookings.find((b) => b.userId === userId)?.status;
  }

  bookingOf(userId: string): BookingRec | undefined {
    return this.bookings.find((b) => b.userId === userId);
  }

  private step(kind: 'read' | 'write', op: string): void {
    this.log.push(`${kind}:${op}`);
    if (this.breakOn === op) {
      this.breakOn = null;
      throw new Error(`fake: ${op} failed`);
    }
  }

  private sessionRow(id: string): Row | null {
    const rec = this.sessions.get(id);
    if (rec === undefined) return null;
    const coach = this.users.get(rec.coachId);
    return {
      ...rec,
      coach: { firstName: coach?.firstName ?? 'Unknown', lastName: coach?.lastName ?? 'Coach' },
      _count: {
        bookings: this.bookings.filter((b) => b.sessionId === id && b.status === 'WAITLISTED')
          .length,
      },
    };
  }
}

function build(session: Partial<SessionRec> = {}) {
  const db = new FakeTimetable();
  const subjects = new Map<string, BookingSubject>();
  const memberships = {
    loadBookingSubject: jest.fn((userId: string) => Promise.resolve(subjects.get(userId) ?? null)),
    loadBookingSubjects: jest.fn((userIds: readonly string[]) =>
      Promise.resolve(
        new Map(
          userIds.flatMap((id): Array<[string, BookingSubject]> => {
            const subject = subjects.get(id);
            return subject === undefined ? [] : [[id, subject]];
          }),
        ),
      ),
    ),
  };
  const sent: MemberNoticeInput[] = [];
  const notices = {
    notify: jest.fn((inputs: readonly MemberNoticeInput[]) => {
      db.log.push('notify');
      sent.push(...inputs);
      return Promise.resolve();
    }),
  };
  const prisma = db as unknown as PrismaService;
  const bookings = new BookingsService(
    prisma,
    gym,
    memberships as unknown as MembershipService,
    notices as unknown as MemberNoticesService,
  );
  const service = new ClassesService(
    prisma,
    gym,
    bookings,
    notices as unknown as MemberNoticesService,
  );

  db.addUser(COACH_ID, 'Ana', 'Cruz', 'COACH');
  db.addUser(NEW_COACH_ID, 'Ben', 'Reyes', 'COACH');
  db.addUser(ADMIN_ID, 'Alex', 'Admin', 'ADMIN');
  db.addUser(CLIENT_ID, 'Carla', 'Client', 'CLIENT');
  db.addSession(session);

  /** A member holding `status` in the class, with a plan that covers it (or the one given). */
  const holder = (n: number, status: Status, subject: BookingSubject = plan()): string => {
    const id = memberId(n);
    subjects.set(id, subject);
    db.addBooking(id, status);
    return id;
  };

  return { db, sent, notices, service, holder };
}

async function refusal(work: Promise<unknown>): Promise<DomainException> {
  try {
    await work;
  } catch (caught) {
    if (caught instanceof DomainException) return caught;
    throw caught;
  }
  throw new Error('expected a DomainException, but the call succeeded');
}

const edit = (dto: UpdateClassSessionDto): UpdateClassSessionDto => dto;

// ═════════════════════════════════════════════════════════════════════════════

describe('ClassesService.update — an edit, under the class lock', () => {
  it('locks the class before reading it, in one 8-second transaction', async () => {
    const ctx = build();
    await ctx.service.update(SESSION_ID, edit({ description: 'Bring water' }), ADMIN_ID, NOW);

    expect(ctx.db.log.slice(0, 2)).toEqual(['begin', `lock:${SESSION_ID}`]);
    expect(ctx.db.txOptions).toEqual([{ timeout: 8_000 }]);
  });

  describe('refusals', () => {
    it('refuses a class that does not exist — CLASS_NOT_FOUND, 404', async () => {
      const ctx = build();
      const error = await refusal(
        ctx.service.update(UNKNOWN_ID, edit({ title: 'X' }), ADMIN_ID, NOW),
      );
      expect([error.code, error.getStatus()]).toEqual(['CLASS_NOT_FOUND', HttpStatus.NOT_FOUND]);
    });

    it('refuses a cancelled class — CLASS_CANCELLED', async () => {
      const ctx = build({
        cancelledAt: new Date('2026-09-13T00:00:00.000Z'),
        cancelReason: 'Coach ill',
      });
      expect(
        (await refusal(ctx.service.update(SESSION_ID, edit({ capacity: 5 }), ADMIN_ID, NOW))).code,
      ).toBe('CLASS_CANCELLED');
    });

    // A class that has ended is history. A running one can still be edited —
    // the end pushed back ten minutes, say.
    it('refuses a class that has ended — CLASS_FINISHED — but not one still running', async () => {
      const ended = build();
      expect(
        (
          await refusal(
            ended.service.update(SESSION_ID, edit({ title: 'Late' }), ADMIN_ID, ENDS_AT),
          )
        ).code,
      ).toBe('CLASS_FINISHED');
      expect(ended.db.log.filter((entry) => entry.startsWith('write:'))).toEqual([]);

      const running = build();
      await expect(
        running.service.update(
          SESSION_ID,
          edit({ endsAt: '2026-09-16T11:10:00.000Z' }),
          ADMIN_ID,
          new Date(STARTS_AT.getTime() + minutes(20)),
        ),
      ).resolves.toMatchObject({ endsAt: '2026-09-16T11:10:00.000Z' });
    });

    // A PATCH carries only what changed: the order is checked on the MERGED
    // times, or moving only the start past the stored end reaches the CHECK.
    it.each([
      ['a start moved past the stored end', { startsAt: '2026-09-16T11:30:00.000Z' }],
      ['an end moved before the stored start', { endsAt: '2026-09-16T09:00:00.000Z' }],
      [
        'an end equal to the start',
        { startsAt: '2026-09-16T12:00:00.000Z', endsAt: '2026-09-16T12:00:00.000Z' },
      ],
    ])('refuses %s — CLASS_ENDS_BEFORE_START', async (_name, dto) => {
      const ctx = build();
      expect((await refusal(ctx.service.update(SESSION_ID, edit(dto), ADMIN_ID, NOW))).code).toBe(
        'CLASS_ENDS_BEFORE_START',
      );
    });

    // 06:00 typed for 18:00: a class moved into the past could never be
    // edited or cancelled again, so the move is refused before any write.
    it.each([
      ['a start moved to an hour ago', { startsAt: '2026-09-14T01:00:00.000Z' }],
      ['a start moved to this very minute', { startsAt: NOW.toISOString() }],
      [
        'the whole class moved to this morning',
        { startsAt: '2026-09-14T00:00:00.000Z', endsAt: '2026-09-14T01:00:00.000Z' },
      ],
    ])('refuses %s on a class that has not started — CLASS_ALREADY_STARTED', async (_name, dto) => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');

      const error = await refusal(ctx.service.update(SESSION_ID, edit(dto), ADMIN_ID, NOW));

      expect([error.code, error.getStatus(), error.message]).toEqual([
        'CLASS_ALREADY_STARTED',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'That start time has already passed. Check the date and the time.',
      ]);
      expect(ctx.db.log.filter((entry) => entry.startsWith('write:'))).toEqual([]);
      expect(ctx.db.session(SESSION_ID).startsAt).toEqual(STARTS_AT);
      expect(ctx.notices.notify).not.toHaveBeenCalled();
    });

    // A running class may run on — but not be ended in the past.
    it('refuses an end moved into the past on a running class — CLASS_FINISHED', async () => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');
      const running = new Date(STARTS_AT.getTime() + minutes(30));

      const error = await refusal(
        ctx.service.update(
          SESSION_ID,
          edit({ endsAt: '2026-09-16T10:20:00.000Z' }),
          ADMIN_ID,
          running,
        ),
      );

      expect([error.code, error.getStatus(), error.message]).toEqual([
        'CLASS_FINISHED',
        HttpStatus.UNPROCESSABLE_ENTITY,
        'That end time has already passed. Check the date and the time.',
      ]);
      expect(ctx.db.log.filter((entry) => entry.startsWith('write:'))).toEqual([]);
      expect(ctx.db.session(SESSION_ID).endsAt).toEqual(ENDS_AT);
    });

    // The start has already come for a running class: only a NEW start into
    // the past is a mistake to catch, so a running class's other edits pass.
    it('lets a running class keep its start while its title changes', async () => {
      const ctx = build();
      await expect(
        ctx.service.update(
          SESSION_ID,
          edit({ title: 'Spin Express' }),
          ADMIN_ID,
          new Date(STARTS_AT.getTime() + minutes(30)),
        ),
      ).resolves.toMatchObject({ title: 'Spin Express' });
    });

    it('checks the order of the times first — CLASS_ENDS_BEFORE_START wins', async () => {
      const ctx = build();
      const error = await refusal(
        ctx.service.update(
          SESSION_ID,
          edit({ startsAt: '2026-09-14T01:00:00.000Z', endsAt: '2026-09-14T00:30:00.000Z' }),
          ADMIN_ID,
          NOW,
        ),
      );
      expect(error.code).toBe('CLASS_ENDS_BEFORE_START');
    });

    it('refuses fewer places than are taken — CAPACITY_BELOW_BOOKED, saying how many', async () => {
      const ctx = build({ capacity: 3 });
      ctx.holder(1, 'BOOKED');
      ctx.holder(2, 'BOOKED');
      ctx.holder(3, 'BOOKED');

      const error = await refusal(
        ctx.service.update(SESSION_ID, edit({ capacity: 2 }), ADMIN_ID, NOW),
      );

      expect([error.code, error.message]).toEqual([
        'CAPACITY_BELOW_BOOKED',
        '3 people are already booked in. Keep at least 3 places, or take someone out of the class first.',
      ]);
    });

    it('says it in the singular for one person', async () => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');
      const error = await refusal(
        ctx.service.update(SESSION_ID, edit({ capacity: 0 }), ADMIN_ID, NOW),
      );
      expect(error.message).toBe(
        '1 person is already booked in. Keep at least 1 place, or take someone out of the class first.',
      );
    });

    it('refuses a coach who is not one — COACH_NOT_FOUND, NOT_A_COACH — on the edit’s transaction', async () => {
      const ctx = build();
      expect(
        (
          await refusal(
            ctx.service.update(SESSION_ID, edit({ coachId: UNKNOWN_ID }), ADMIN_ID, NOW),
          )
        ).code,
      ).toBe('COACH_NOT_FOUND');
      expect(
        (await refusal(ctx.service.update(SESSION_ID, edit({ coachId: CLIENT_ID }), ADMIN_ID, NOW)))
          .code,
      ).toBe('NOT_A_COACH');
      // Both asked after the lock, inside the transaction.
      expect(ctx.db.log.indexOf('read:user.findUnique')).toBeGreaterThan(
        ctx.db.log.indexOf(`lock:${SESSION_ID}`),
      );
    });
  });

  // 17:00 UTC is 1:00 AM the next day in Manila.
  it('moves the gym day with the start', async () => {
    const ctx = build();
    const dto = await ctx.service.update(
      SESSION_ID,
      edit({ startsAt: '2026-09-16T17:00:00.000Z', endsAt: '2026-09-16T18:00:00.000Z' }),
      ADMIN_ID,
      NOW,
    );
    expect(dto.businessDate).toBe('2026-09-17');
  });

  describe('a capacity raise fills from the waitlist (F1)', () => {
    it('promotes min(waiting, new seats), first eligible first, and tells them after the commit', async () => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');
      ctx.holder(2, 'BOOKED');
      const lapsed = ctx.holder(3, 'WAITLISTED', plan({ membership: null }));
      const first = ctx.holder(4, 'WAITLISTED');
      const second = ctx.holder(5, 'WAITLISTED');
      const third = ctx.holder(6, 'WAITLISTED');

      const dto = await ctx.service.update(SESSION_ID, edit({ capacity: 4 }), ADMIN_ID, NOW);

      expect([lapsed, first, second, third].map((id) => ctx.db.statusOf(id))).toEqual([
        'WAITLISTED',
        'BOOKED',
        'BOOKED',
        'WAITLISTED',
      ]);
      // The answer is the class after the promotions.
      expect(dto).toMatchObject({ capacity: 4, bookedCount: 4, seatsLeft: 0, waitlistCount: 2 });
      expect(ctx.sent.map((notice) => [notice.kind, notice.userId])).toEqual([
        ['CLASS_PROMOTED', first],
        ['CLASS_PROMOTED', second],
      ]);
      expect(ctx.db.log.indexOf('notify')).toBeGreaterThan(ctx.db.log.indexOf('commit'));
    });

    it('promotes everybody waiting when the raise is bigger than the queue', async () => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');
      ctx.holder(2, 'BOOKED');
      ctx.holder(3, 'WAITLISTED');

      const dto = await ctx.service.update(SESSION_ID, edit({ capacity: 6 }), ADMIN_ID, NOW);

      expect(dto).toMatchObject({ bookedCount: 3, seatsLeft: 3, waitlistCount: 0 });
    });

    // From the cutoff, nobody moves up by themselves: the seats are free for
    // whoever books first (owner, 2026-10-11).
    it('promotes nobody once the waitlist has closed', async () => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');
      ctx.holder(2, 'BOOKED');
      const waiting = ctx.holder(3, 'WAITLISTED');

      const dto = await ctx.service.update(
        SESSION_ID,
        edit({ capacity: 4 }),
        ADMIN_ID,
        beforeStart(120),
      );

      expect(ctx.db.statusOf(waiting)).toBe('WAITLISTED');
      expect(dto).toMatchObject({ seatsLeft: 2, waitlistCount: 1 });
      expect(ctx.notices.notify).not.toHaveBeenCalled();
    });

    it('rolls the whole edit back, and tells nobody, when the promotion fails', async () => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');
      ctx.holder(2, 'BOOKED');
      const waiting = ctx.holder(3, 'WAITLISTED');
      ctx.db.breakOn = 'classBooking.updateMany';

      await expect(
        ctx.service.update(SESSION_ID, edit({ capacity: 4 }), ADMIN_ID, NOW),
      ).rejects.toThrow('failed');

      expect(ctx.db.session(SESSION_ID).capacity).toBe(2);
      expect(ctx.db.statusOf(waiting)).toBe('WAITLISTED');
      expect(ctx.notices.notify).not.toHaveBeenCalled();
    });
  });

  describe('CLASS_CHANGED — the time, the coach or the title', () => {
    it('tells everybody holding a seat or waiting, and nobody else', async () => {
      const ctx = build({ capacity: 1 });
      const seated = ctx.holder(1, 'BOOKED');
      const waiting = ctx.holder(2, 'WAITLISTED');
      ctx.holder(3, 'CANCELLED');

      await ctx.service.update(
        SESSION_ID,
        edit({ startsAt: '2026-09-16T11:00:00.000Z', endsAt: '2026-09-16T12:00:00.000Z' }),
        ADMIN_ID,
        NOW,
      );

      expect(ctx.sent.map((notice) => notice.userId)).toEqual([seated, waiting]);
      expect(ctx.sent[0]).toEqual({
        userId: seated,
        kind: 'CLASS_CHANGED',
        // Named as the member knew it; the body says what is new.
        title: 'Changed: Spin, Wed 16 Sep',
        body: 'It now runs Wed 16 Sep, 7:00 PM to 8:00 PM. If that no longer works for you, cancel so someone else can have the place.',
        linkPath: '/portal/book?date=2026-09-16',
        subjectType: 'ClassSession',
        subjectId: SESSION_ID,
        dedupeKey: expect.stringMatching(
          new RegExp(
            `^CLASS_CHANGED:${SESSION_ID}:${seated}:${Date.parse('2026-09-16T11:00:00.000Z')}:${Date.parse('2026-09-16T12:00:00.000Z')}:${COACH_ID}:[0-9a-f]{12}:${NOW.getTime()}$`,
          ),
        ),
      });
    });

    it('names the new coach, and the new title', async () => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');

      await ctx.service.update(
        SESSION_ID,
        edit({ coachId: NEW_COACH_ID, title: 'Spin Express' }),
        ADMIN_ID,
        NOW,
      );

      expect(ctx.sent).toHaveLength(1);
      expect(ctx.sent[0]?.body).toBe('Your coach is now Ben Reyes. It is now called Spin Express.');
      expect(ctx.sent[0]?.title).toBe('Changed: Spin, Wed 16 Sep');
    });

    it('treats the places and the description as nobody’s news', async () => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');

      await ctx.service.update(
        SESSION_ID,
        edit({ capacity: 3, description: 'Bring water' }),
        ADMIN_ID,
        NOW,
      );

      expect(ctx.notices.notify).not.toHaveBeenCalled();
    });

    // The register opens 30 minutes early: a member marked in before the
    // start is as affected by a move as anybody booked.
    it('before the start, tells the members the register has already marked', async () => {
      const ctx = build({ capacity: 3 });
      const seated = ctx.holder(1, 'BOOKED');
      const arrived = ctx.holder(2, 'ATTENDED');
      const missing = ctx.holder(3, 'NO_SHOW');
      const waiting = ctx.holder(4, 'WAITLISTED');
      ctx.holder(5, 'CANCELLED');

      await ctx.service.update(
        SESSION_ID,
        edit({ coachId: NEW_COACH_ID }),
        ADMIN_ID,
        beforeStart(20),
      );

      expect(ctx.sent.map((notice) => notice.userId).sort()).toEqual(
        [seated, arrived, missing, waiting].sort(),
      );
    });

    // A waitlist place on a running class reads "No place": the change is not
    // their news. Nor can anybody cancel now, so nobody is told to.
    it('once the class is running, tells the seats only — not the waitlist — and advises no cancel', async () => {
      const ctx = build({ capacity: 3 });
      const seated = ctx.holder(1, 'BOOKED');
      const arrived = ctx.holder(2, 'ATTENDED');
      const missing = ctx.holder(3, 'NO_SHOW');
      ctx.holder(4, 'WAITLISTED');

      await ctx.service.update(
        SESSION_ID,
        edit({ endsAt: '2026-09-16T11:15:00.000Z' }),
        ADMIN_ID,
        new Date(STARTS_AT.getTime() + minutes(20)),
      );

      expect(ctx.sent.map((notice) => notice.userId).sort()).toEqual(
        [seated, arrived, missing].sort(),
      );
      expect(ctx.sent[0]?.body).toBe('It now runs Wed 16 Sep, 6:00 PM to 7:15 PM.');
    });

    // Somebody who booked as a member and has since joined the staff.
    it('never tells the editor about their own edit', async () => {
      const ctx = build();
      const member = ctx.holder(1, 'BOOKED');
      ctx.db.addBooking(ADMIN_ID, 'WAITLISTED');

      await ctx.service.update(SESSION_ID, edit({ title: 'Spin Express' }), ADMIN_ID, NOW);

      expect(ctx.sent.map((notice) => notice.userId)).toEqual([member]);
    });

    // A → B → A → B: the second "now B" is the one the member needs, so the
    // key cannot be the new values alone.
    it('tells a member every time, even when a change goes back and forth', async () => {
      const ctx = build();
      ctx.holder(1, 'BOOKED');
      const at = (n: number): Date => new Date(NOW.getTime() + minutes(n));

      await ctx.service.update(SESSION_ID, edit({ coachId: NEW_COACH_ID }), ADMIN_ID, at(1));
      await ctx.service.update(SESSION_ID, edit({ coachId: COACH_ID }), ADMIN_ID, at(2));
      await ctx.service.update(SESSION_ID, edit({ coachId: NEW_COACH_ID }), ADMIN_ID, at(3));

      const keys = ctx.sent.map((notice) => notice.dedupeKey);
      expect(keys).toHaveLength(3);
      expect(new Set(keys).size).toBe(3);
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('ClassesService.cancel — calling a class off', () => {
  it('keeps every booking and the counter, and tells everybody holding a place, after the commit', async () => {
    const ctx = build({ capacity: 1 });
    const seated = ctx.holder(1, 'BOOKED');
    const waiting = ctx.holder(2, 'WAITLISTED');
    ctx.holder(3, 'CANCELLED');

    const dto = await ctx.service.cancel(SESSION_ID, 'Coach is unwell', ADMIN_ID, NOW);

    expect(dto).toMatchObject({
      cancelledAt: NOW.toISOString(),
      cancelReason: 'Coach is unwell',
      bookedCount: 1,
      waitlistCount: 1,
    });
    expect([seated, waiting].map((id) => ctx.db.statusOf(id))).toEqual(['BOOKED', 'WAITLISTED']);
    expect(ctx.sent).toEqual(
      [seated, waiting].map((userId) => ({
        userId,
        kind: 'CLASS_CANCELLED',
        title: 'Cancelled: Spin, Wed 16 Sep 6:00 PM',
        body: 'Coach is unwell',
        linkPath: '/portal/book?date=2026-09-16',
        subjectType: 'ClassSession',
        subjectId: SESSION_ID,
        dedupeKey: `CLASS_CANCELLED:${SESSION_ID}:${userId}`,
      })),
    );
    expect(ctx.db.log.indexOf('notify')).toBeGreaterThan(ctx.db.log.indexOf('commit'));
  });

  // The register opens 30 minutes before the start, so a class called off at
  // the last minute can already carry marks. It never ran: those members are
  // told like everybody else, and their marks go back to a plain seat.
  it('tells the members marked early, and undoes their marks — the class never ran', async () => {
    const ctx = build({ capacity: 3 });
    const seated = ctx.holder(1, 'BOOKED');
    const arrived = ctx.holder(2, 'ATTENDED');
    const missing = ctx.holder(3, 'NO_SHOW');
    const waiting = ctx.holder(4, 'WAITLISTED');

    const dto = await ctx.service.cancel(SESSION_ID, 'Coach is unwell', ADMIN_ID, beforeStart(10));

    expect(ctx.sent.map((notice) => notice.userId).sort()).toEqual(
      [seated, arrived, missing, waiting].sort(),
    );
    expect(ctx.sent.every((notice) => notice.kind === 'CLASS_CANCELLED')).toBe(true);
    for (const id of [arrived, missing]) {
      expect(ctx.db.bookingOf(id)).toMatchObject({
        status: 'BOOKED',
        attendedAt: null,
        markedAt: null,
        markedById: null,
      });
    }
    expect(ctx.db.statusOf(waiting)).toBe('WAITLISTED');
    // Each was a seat already: the "affected" count does not move.
    expect(ctx.db.session(SESSION_ID).bookedCount).toBe(3);
    expect(dto).toMatchObject({ bookedCount: 3, waitlistCount: 1 });
    expect(ctx.db.log.indexOf('notify')).toBeGreaterThan(ctx.db.log.indexOf('commit'));
  });

  it('undoes no mark, and tells nobody, when the cancel is refused', async () => {
    const ctx = build();
    const arrived = ctx.holder(1, 'ATTENDED');

    await refusal(ctx.service.cancel(SESSION_ID, 'Too late', ADMIN_ID, STARTS_AT));

    expect(ctx.db.bookingOf(arrived)).toMatchObject({ status: 'ATTENDED', markedById: COACH_ID });
    expect(ctx.notices.notify).not.toHaveBeenCalled();
  });

  it('locks the class first', async () => {
    const ctx = build();
    await ctx.service.cancel(SESSION_ID, 'Coach is unwell', ADMIN_ID, NOW);
    expect(ctx.db.log.slice(0, 2)).toEqual(['begin', `lock:${SESSION_ID}`]);
  });

  it('sends nothing when nobody holds a place', async () => {
    const ctx = build();
    await ctx.service.cancel(SESSION_ID, 'Coach is unwell', ADMIN_ID, NOW);
    expect(ctx.notices.notify).not.toHaveBeenCalled();
  });

  it('refuses a class that does not exist — CLASS_NOT_FOUND, 404', async () => {
    const ctx = build();
    const error = await refusal(ctx.service.cancel(UNKNOWN_ID, 'Coach is unwell', ADMIN_ID, NOW));
    expect([error.code, error.getStatus()]).toEqual(['CLASS_NOT_FOUND', HttpStatus.NOT_FOUND]);
  });

  it('refuses a class already cancelled — CLASS_ALREADY_CANCELLED', async () => {
    const ctx = build({ cancelledAt: new Date('2026-09-13T00:00:00.000Z'), cancelReason: 'Flood' });
    expect(
      (await refusal(ctx.service.cancel(SESSION_ID, 'Coach is unwell', ADMIN_ID, NOW))).code,
    ).toBe('CLASS_ALREADY_CANCELLED');
  });

  // It ran: cancelling it afterwards would lock its register and tell
  // everybody who came that it never happened.
  it('refuses a class that has started — CLASS_ALREADY_STARTED — and allows one a minute before', async () => {
    const started = build();
    started.holder(1, 'BOOKED');
    expect(
      (await refusal(started.service.cancel(SESSION_ID, 'Too late', ADMIN_ID, STARTS_AT))).code,
    ).toBe('CLASS_ALREADY_STARTED');
    expect(started.notices.notify).not.toHaveBeenCalled();

    const justBefore = build();
    await expect(
      justBefore.service.cancel(SESSION_ID, 'Coach is unwell', ADMIN_ID, beforeStart(1)),
    ).resolves.toMatchObject({ cancelReason: 'Coach is unwell' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('ClassesService — every session it answers with carries its waitlist length', () => {
  const COUNT = { select: { bookings: { where: { status: 'WAITLISTED' } } } };

  it('list counts the queue in the same query', async () => {
    const ctx = build({ capacity: 1 });
    ctx.holder(1, 'BOOKED');
    ctx.holder(2, 'WAITLISTED');
    ctx.holder(3, 'WAITLISTED');

    const [dto] = await ctx.service.list({}, NOW);

    expect(ctx.db.classSession.findMany.mock.calls[0]?.[0]?.include).toMatchObject({
      _count: COUNT,
    });
    expect(dto).toMatchObject({ isFull: true, waitlistCount: 2 });
  });

  it('findOne counts it too, and answers 404 for an unknown class', async () => {
    const ctx = build({ capacity: 1 });
    ctx.holder(1, 'BOOKED');
    ctx.holder(2, 'WAITLISTED');

    await expect(ctx.service.findOne(SESSION_ID)).resolves.toMatchObject({ waitlistCount: 1 });
    expect(ctx.db.classSession.findUnique.mock.calls[0]?.[0]?.include).toMatchObject({
      _count: COUNT,
    });
    expect((await refusal(ctx.service.findOne(UNKNOWN_ID))).code).toBe('CLASS_NOT_FOUND');
  });

  it('create answers with an empty queue', async () => {
    const ctx = build();
    const dto = await ctx.service.create(
      ADMIN_ID,
      {
        title: 'Yoga',
        coachId: COACH_ID,
        startsAt: '2026-09-20T01:00:00.000Z',
        endsAt: '2026-09-20T02:00:00.000Z',
        capacity: 12,
      },
      NOW,
    );
    expect(dto).toMatchObject({ title: 'Yoga', businessDate: '2026-09-20', waitlistCount: 0 });
  });

  it('roster is today’s list, in the gym’s day', async () => {
    const ctx = build();
    const rows = await ctx.service.roster(new Date('2026-09-16T01:00:00.000Z'));
    expect(rows.map((row) => row.id)).toEqual([SESSION_ID]);
  });
});

// ═════════════════════════════════════════════════════════════════════════════

describe('ClassesService.create — never in the past', () => {
  const yoga = (startsAt: string, endsAt: string) => ({
    title: 'Yoga',
    coachId: COACH_ID,
    startsAt,
    endsAt,
    capacity: 12,
  });

  // 06:00 typed for 18:00: a class created in the past could never be edited
  // or cancelled afterwards (both refuse a class that has started).
  it.each([
    ['earlier today', '2026-09-13T22:00:00.000Z', '2026-09-13T23:00:00.000Z'],
    ['starting this very minute', NOW.toISOString(), '2026-09-14T03:00:00.000Z'],
  ])('refuses a start %s — CLASS_ALREADY_STARTED, creating nothing', async (_name, from, to) => {
    const ctx = build();

    const error = await refusal(ctx.service.create(ADMIN_ID, yoga(from, to), NOW));

    expect([error.code, error.getStatus(), error.message]).toEqual([
      'CLASS_ALREADY_STARTED',
      HttpStatus.UNPROCESSABLE_ENTITY,
      'That start time has already passed. Check the date and the time.',
    ]);
    expect(ctx.db.classSession.create).not.toHaveBeenCalled();
  });

  it('creates a class starting a minute from now', async () => {
    const ctx = build();
    await expect(
      ctx.service.create(
        ADMIN_ID,
        yoga('2026-09-14T02:01:00.000Z', '2026-09-14T03:00:00.000Z'),
        NOW,
      ),
    ).resolves.toMatchObject({ startsAt: '2026-09-14T02:01:00.000Z' });
  });

  it('still names the order of the times first — CLASS_ENDS_BEFORE_START', async () => {
    const ctx = build();
    const error = await refusal(
      ctx.service.create(
        ADMIN_ID,
        yoga('2026-09-13T22:00:00.000Z', '2026-09-13T21:00:00.000Z'),
        NOW,
      ),
    );
    expect(error.code).toBe('CLASS_ENDS_BEFORE_START');
  });

  // The controller passes no clock; the service reads the real one.
  it('reads the real clock when none is given', async () => {
    const ctx = build();
    const error = await refusal(
      ctx.service.create(ADMIN_ID, yoga('2020-01-01T01:00:00.000Z', '2020-01-01T02:00:00.000Z')),
    );
    expect(error.code).toBe('CLASS_ALREADY_STARTED');
  });
});

// ═════════════════════════════════════════════════════════════════════════════

/**
 * Coaches run their own classes (owner, 2026-10-23): COACH holds
 * `class.manage` at OWN, and the controller passes the caller as `ownerId`.
 * The same service, so the same time, capacity and coach checks as the admin.
 */
describe('ClassesService — a coach managing their own classes (ownerId)', () => {
  const yoga = (coachId: string) => ({
    title: 'Yoga',
    coachId,
    startsAt: '2026-09-20T01:00:00.000Z',
    endsAt: '2026-09-20T02:00:00.000Z',
    capacity: 12,
  });

  const notYours = (error: DomainException): void => {
    expect([error.code, error.getStatus(), error.message]).toEqual([
      'CLASS_NOT_YOURS',
      HttpStatus.FORBIDDEN,
      'You can only create, change or cancel classes you coach.',
    ]);
  };

  it('lets a coach create a class they coach', async () => {
    const ctx = build();
    await expect(
      ctx.service.create(COACH_ID, yoga(COACH_ID), NOW, COACH_ID),
    ).resolves.toMatchObject({ title: 'Yoga', coachId: COACH_ID });
  });

  it('refuses a coach creating a class for another coach — 403, nothing created', async () => {
    const ctx = build();
    notYours(await refusal(ctx.service.create(COACH_ID, yoga(NEW_COACH_ID), NOW, COACH_ID)));
    expect(ctx.db.classSession.create).not.toHaveBeenCalled();
  });

  it('runs the admin checks for a coach too', async () => {
    const ctx = build();
    const past = { ...yoga(COACH_ID), startsAt: '2026-09-13T01:00:00.000Z' };
    expect((await refusal(ctx.service.create(COACH_ID, past, NOW, COACH_ID))).code).toBe(
      'CLASS_ALREADY_STARTED',
    );
  });

  it('lets a coach edit and cancel their own class', async () => {
    const ctx = build({ coachId: COACH_ID });
    await expect(
      ctx.service.update(SESSION_ID, edit({ title: 'Spin Express' }), COACH_ID, NOW, COACH_ID),
    ).resolves.toMatchObject({ title: 'Spin Express' });
    await expect(
      ctx.service.cancel(SESSION_ID, 'Coach is unwell', COACH_ID, NOW, COACH_ID),
    ).resolves.toMatchObject({ cancelReason: 'Coach is unwell' });
  });

  it("refuses a coach editing or cancelling another coach's class, changing nothing", async () => {
    const ctx = build({ coachId: NEW_COACH_ID });
    const before = { ...ctx.db.sessions.get(SESSION_ID) };
    notYours(
      await refusal(
        ctx.service.update(SESSION_ID, edit({ title: 'Mine now' }), COACH_ID, NOW, COACH_ID),
      ),
    );
    notYours(await refusal(ctx.service.cancel(SESSION_ID, 'Nope', COACH_ID, NOW, COACH_ID)));
    expect(ctx.db.sessions.get(SESSION_ID)).toEqual(before);
  });

  it('refuses a coach handing their own class to another coach', async () => {
    const ctx = build({ coachId: COACH_ID });
    notYours(
      await refusal(
        ctx.service.update(SESSION_ID, edit({ coachId: NEW_COACH_ID }), COACH_ID, NOW, COACH_ID),
      ),
    );
    expect(ctx.db.sessions.get(SESSION_ID)?.coachId).toBe(COACH_ID);
  });

  it('leaves the admin (no ownerId) unchanged: any coach, any class', async () => {
    const ctx = build({ coachId: COACH_ID });
    await expect(ctx.service.create(ADMIN_ID, yoga(NEW_COACH_ID), NOW)).resolves.toMatchObject({
      coachId: NEW_COACH_ID,
    });
    await expect(
      ctx.service.update(SESSION_ID, edit({ coachId: NEW_COACH_ID }), ADMIN_ID, NOW),
    ).resolves.toMatchObject({ coachId: NEW_COACH_ID });
  });
});
