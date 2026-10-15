import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bookingRefusalCopy, DenialReason, MembershipStatus } from '@got/shared';
import { addDays, asCivilDate, civilDaysBetween, shortDate } from '../common/time/gym-time';
import type { CivilDate } from '../common/time/gym-time';
import type { MembershipSnapshot } from './access-verdict';
import { bookingEligibility } from './booking-eligibility';
import type { BookingEligibility, BookingSubject, ScheduledHold } from './booking-eligibility';

const d = (value: string): CivilDate => asCivilDate(value);

/** A Monthly term, 1–31 Aug 2026, nobody frozen, nobody leaving. */
function snapshot(overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    status: MembershipStatus.ACTIVE,
    startsOn: d('2026-08-01'),
    endsOn: d('2026-08-31'),
    graceDays: 3,
    graceAdmissionsThisTerm: 0,
    cancelRequestedOn: null,
    planName: 'Monthly',
    planPriceCentavos: 80000,
    hold: null,
    ...overrides,
  };
}

/** A booked freeze over an inclusive window; its length is what activation adds. */
function hold(startsOn: string, endsOn: string): ScheduledHold {
  return {
    startsOn: d(startsOn),
    endsOn: d(endsOn),
    daysRequested: civilDaysBetween(d(startsOn), d(endsOn)) + 1,
  };
}

function subject(overrides: Partial<BookingSubject> = {}): BookingSubject {
  return {
    userStatus: 'ACTIVE',
    membership: snapshot(),
    scheduledHolds: [],
    planCode: 'MONTHLY',
    ...overrides,
  };
}

const ok = (coversUntil: string): BookingEligibility => ({
  eligible: true,
  reason: null,
  relevantDate: null,
  coversUntil: d(coversUntil),
});

const no = (
  reason: DenialReason,
  relevantDate: string | null,
  coversUntil: string | null,
): BookingEligibility => ({
  eligible: false,
  reason,
  relevantDate: relevantDate === null ? null : d(relevantDate),
  coversUntil: coversUntil === null ? null : d(coversUntil),
});

/**
 * Frozen 10–23 Aug by a hold that started on time: activation already pushed
 * the 31 Aug end out by the hold's 14 days, to 14 Sep.
 */
const FROZEN_NOW = snapshot({
  status: MembershipStatus.FROZEN,
  endsOn: d('2026-09-14'),
  hold: { startsOn: d('2026-08-10'), endsOn: d('2026-08-23') },
});

describe('bookingEligibility — the cases a member actually meets', () => {
  const cases: ReadonlyArray<[string, BookingSubject, string, BookingEligibility]> = [
    ['active, class mid-term', subject(), '2026-08-14', ok('2026-08-31')],
    ['active, class on the last day of the term', subject(), '2026-08-31', ok('2026-08-31')],
    [
      'active, class the day after the term — grace does not count',
      subject(),
      '2026-09-01',
      no(DenialReason.MEMBERSHIP_EXPIRED, '2026-08-31', '2026-08-31'),
    ],
    [
      'notice given, class inside the term',
      subject({ membership: snapshot({ cancelRequestedOn: d('2026-08-10') }) }),
      '2026-08-20',
      ok('2026-08-31'),
    ],
    [
      'notice given, class after the term',
      subject({ membership: snapshot({ cancelRequestedOn: d('2026-08-10') }) }),
      '2026-09-03',
      no(DenialReason.MEMBERSHIP_CANCELLED, '2026-08-31', '2026-08-31'),
    ],
    [
      'frozen, class inside the running hold',
      subject({ membership: FROZEN_NOW }),
      '2026-08-20',
      no(DenialReason.MEMBERSHIP_FROZEN, '2026-08-23', '2026-09-14'),
    ],
    [
      'frozen, class after the running hold ends (the self-heal)',
      subject({ membership: FROZEN_NOW }),
      '2026-08-25',
      ok('2026-09-14'),
    ],
    [
      'frozen, class after the extended term',
      subject({ membership: FROZEN_NOW }),
      '2026-09-15',
      no(DenialReason.MEMBERSHIP_EXPIRED, '2026-09-14', '2026-09-14'),
    ],
    [
      'frozen with the running hold row missing',
      subject({ membership: snapshot({ ...FROZEN_NOW, hold: null }) }),
      '2026-09-01',
      no(DenialReason.MEMBERSHIP_FROZEN, null, null),
    ],
    [
      'a booked freeze covers the class',
      subject({ scheduledHolds: [hold('2026-08-20', '2026-08-26')] }),
      '2026-08-22',
      no(DenialReason.MEMBERSHIP_FROZEN, '2026-08-26', '2026-09-07'),
    ],
    [
      'class before a booked freeze',
      subject({ scheduledHolds: [hold('2026-08-20', '2026-08-26')] }),
      '2026-08-15',
      ok('2026-09-07'),
    ],
    [
      'class after a booked freeze: past the stored end, inside the projected one',
      subject({ scheduledHolds: [hold('2026-08-20', '2026-08-26')] }),
      '2026-09-05',
      ok('2026-09-07'),
    ],
    [
      'class after the projected end',
      subject({ scheduledHolds: [hold('2026-08-20', '2026-08-26')] }),
      '2026-09-08',
      no(DenialReason.MEMBERSHIP_EXPIRED, '2026-09-07', '2026-09-07'),
    ],
    [
      "early renewal: startsOn is already the NEXT term's first day",
      subject({ membership: snapshot({ startsOn: d('2026-09-01'), endsOn: d('2026-09-30') }) }),
      '2026-08-20',
      ok('2026-09-30'),
    ],
    [
      'EXPIRED, class inside the old grace window',
      subject({ membership: snapshot({ status: MembershipStatus.EXPIRED }) }),
      '2026-09-02',
      no(DenialReason.MEMBERSHIP_EXPIRED, '2026-08-31', null),
    ],
    [
      'EXPIRED, comp days moved endsOn past the class but not the status',
      subject({
        membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-09-30') }),
      }),
      '2026-09-10',
      no(DenialReason.MEMBERSHIP_EXPIRED, null, null),
    ],
    [
      'ACTIVE the nightly job has not expired yet',
      subject(),
      '2026-09-10',
      no(DenialReason.MEMBERSHIP_EXPIRED, '2026-08-31', '2026-08-31'),
    ],
    [
      'ACTIVE under notice the nightly job has not closed yet',
      subject({ membership: snapshot({ cancelRequestedOn: d('2026-08-01') }) }),
      '2026-09-10',
      no(DenialReason.MEMBERSHIP_CANCELLED, '2026-08-31', '2026-08-31'),
    ],
    [
      'CANCELLED by a termination, with endsOn still ahead of the class',
      subject({ membership: snapshot({ status: MembershipStatus.CANCELLED }) }),
      '2026-08-20',
      no(DenialReason.MEMBERSHIP_CANCELLED, null, null),
    ],
    [
      'CANCELLED by the job once a notice term ran out',
      subject({
        membership: snapshot({
          status: MembershipStatus.CANCELLED,
          cancelRequestedOn: d('2026-08-01'),
        }),
      }),
      '2026-09-05',
      no(DenialReason.MEMBERSHIP_CANCELLED, null, null),
    ],
    [
      'no membership',
      subject({ membership: null, planCode: null }),
      '2026-08-14',
      no(DenialReason.NO_MEMBERSHIP, null, null),
    ],
    [
      'account suspended, even with a running plan',
      subject({ userStatus: 'SUSPENDED' }),
      '2026-08-14',
      no(DenialReason.ACCOUNT_SUSPENDED, null, '2026-08-31'),
    ],
    [
      'account deactivated',
      subject({ userStatus: 'DEACTIVATED' }),
      '2026-08-14',
      no(DenialReason.ACCOUNT_DEACTIVATED, null, '2026-08-31'),
    ],
  ];

  it.each(cases)('%s', (_label, subj, classDay, expected) => {
    expect(bookingEligibility(subj, d(classDay))).toEqual(expected);
  });
});

describe('bookingEligibility — precedence', () => {
  it('the account gate beats having no plan at all', () => {
    expect(
      bookingEligibility(subject({ userStatus: 'SUSPENDED', membership: null }), d('2026-08-14')),
    ).toEqual(no(DenialReason.ACCOUNT_SUSPENDED, null, null));
  });

  it('the account gate beats a frozen plan', () => {
    expect(
      bookingEligibility(
        subject({ userStatus: 'DEACTIVATED', membership: FROZEN_NOW }),
        d('2026-08-20'),
      ).reason,
    ).toBe(DenialReason.ACCOUNT_DEACTIVATED);
  });

  it('a freeze inside the term is reported as a freeze, not as the term', () => {
    const result = bookingEligibility(
      subject({ scheduledHolds: [hold('2026-08-25', '2026-08-31')] }),
      d('2026-08-31'),
    );
    expect(result.reason).toBe(DenialReason.MEMBERSHIP_FROZEN);
  });

  it.each(['2026-09-01', '2026-09-02', '2026-09-03'])(
    'never books on grace: %s, inside the 3 grace days, is refused',
    (classDay) => {
      expect(bookingEligibility(subject(), d(classDay)).reason).toBe(
        DenialReason.MEMBERSHIP_EXPIRED,
      );
    },
  );

  it('never reads the plan code: how far ahead is a separate question', () => {
    for (const classDay of ['2026-08-14', '2026-09-01']) {
      expect(bookingEligibility(subject({ planCode: 'ANNUAL' }), d(classDay))).toEqual(
        bookingEligibility(subject({ planCode: null }), d(classDay)),
      );
    }
  });
});

describe('bookingEligibility — booked freezes, as the nightly job will apply them', () => {
  it('a leaver keeps the days a freeze booked inside their term pushes out', () => {
    // Notice given, endsOn 31 Aug, a 7-day freeze inside the term: activation
    // moves the end to 7 Sep before the job ever closes the term. The stored
    // endsOn alone would refuse 1–7 Sep, classes they have paid for.
    const leaver = subject({
      membership: snapshot({ cancelRequestedOn: d('2026-08-10') }),
      scheduledHolds: [hold('2026-08-20', '2026-08-26')],
    });
    expect(bookingEligibility(leaver, d('2026-09-05'))).toEqual(ok('2026-09-07'));
    expect(bookingEligibility(leaver, d('2026-09-08'))).toEqual(
      no(DenialReason.MEMBERSHIP_CANCELLED, '2026-09-07', '2026-09-07'),
    );
  });

  it('adds up every freeze that starts within the term', () => {
    const twice = subject({
      scheduledHolds: [hold('2026-08-10', '2026-08-16'), hold('2026-08-24', '2026-08-30')],
    });
    expect(bookingEligibility(twice, d('2026-09-14'))).toEqual(ok('2026-09-14'));
    expect(bookingEligibility(twice, d('2026-09-15'))).toEqual(
      no(DenialReason.MEMBERSHIP_EXPIRED, '2026-09-14', '2026-09-14'),
    );
  });

  it('counts a second freeze that starts after the stored end but inside the projected one', () => {
    const chained = subject({
      scheduledHolds: [hold('2026-08-25', '2026-08-31'), hold('2026-09-03', '2026-09-09')],
    });
    expect(bookingEligibility(chained, d('2026-09-01'))).toEqual(ok('2026-09-14'));
    expect(bookingEligibility(chained, d('2026-09-05'))).toEqual(
      no(DenialReason.MEMBERSHIP_FROZEN, '2026-09-09', '2026-09-14'),
    );
    expect(bookingEligibility(chained, d('2026-09-12'))).toEqual(ok('2026-09-14'));
  });

  it('a freeze booked after the term has run out adds no bookable day', () => {
    // Nothing stops staff booking one past the term's end today. Activation
    // would stretch endsOn only into its own frozen window.
    const late = subject({ scheduledHolds: [hold('2026-09-05', '2026-09-18')] });
    expect(bookingEligibility(late, d('2026-09-03'))).toEqual(
      no(DenialReason.MEMBERSHIP_EXPIRED, '2026-08-31', '2026-08-31'),
    );
    expect(bookingEligibility(late, d('2026-09-10'))).toEqual(
      no(DenialReason.MEMBERSHIP_FROZEN, '2026-09-18', '2026-08-31'),
    );
    expect(bookingEligibility(late, d('2026-09-20'))).toEqual(
      no(DenialReason.MEMBERSHIP_EXPIRED, '2026-08-31', '2026-08-31'),
    );
  });

  it('nor does one that starts the day after the term ends', () => {
    const next = subject({ scheduledHolds: [hold('2026-09-01', '2026-09-14')] });
    expect(bookingEligibility(next, d('2026-08-31'))).toEqual(ok('2026-08-31'));
    expect(bookingEligibility(next, d('2026-09-15'))).toEqual(
      no(DenialReason.MEMBERSHIP_EXPIRED, '2026-08-31', '2026-08-31'),
    );
  });

  it('back-to-back freezes: the member is told the day they are actually back', () => {
    const backToBack = subject({
      membership: FROZEN_NOW,
      scheduledHolds: [hold('2026-08-24', '2026-09-06')],
    });
    // Inside the running hold, and inside the booked one straight after it.
    expect(bookingEligibility(backToBack, d('2026-08-20'))).toEqual(
      no(DenialReason.MEMBERSHIP_FROZEN, '2026-09-06', '2026-09-28'),
    );
    expect(bookingEligibility(backToBack, d('2026-08-30'))).toEqual(
      no(DenialReason.MEMBERSHIP_FROZEN, '2026-09-06', '2026-09-28'),
    );
    expect(bookingEligibility(backToBack, d('2026-09-07'))).toEqual(ok('2026-09-28'));
  });

  it('a freeze the job failed to start on time still freezes, and still extends', () => {
    // Late activation applies the full length (membership-nightly.job), so the
    // projection does too. The door, deliberately, does not honour it yet.
    const late = subject({ scheduledHolds: [hold('2026-08-05', '2026-08-11')] });
    expect(bookingEligibility(late, d('2026-08-09'))).toEqual(
      no(DenialReason.MEMBERSHIP_FROZEN, '2026-08-11', '2026-09-07'),
    );
    expect(bookingEligibility(late, d('2026-09-05'))).toEqual(ok('2026-09-07'));
  });

  it('a frozen leaver whose hold has ended is refused as a leaver past the end', () => {
    const frozenLeaver = subject({
      membership: snapshot({ ...FROZEN_NOW, cancelRequestedOn: d('2026-08-05') }),
    });
    expect(bookingEligibility(frozenLeaver, d('2026-09-01'))).toEqual(ok('2026-09-14'));
    expect(bookingEligibility(frozenLeaver, d('2026-09-20'))).toEqual(
      no(DenialReason.MEMBERSHIP_CANCELLED, '2026-09-14', '2026-09-14'),
    );
  });

  it('gives the same answers whatever order the holds arrive in', () => {
    const forward = [hold('2026-08-10', '2026-08-16'), hold('2026-08-24', '2026-08-30')];
    const backward = [...forward].reverse();
    for (const classDay of everyDay('2026-08-01', '2026-09-30')) {
      expect(bookingEligibility(subject({ scheduledHolds: backward }), classDay)).toEqual(
        bookingEligibility(subject({ scheduledHolds: forward }), classDay),
      );
    }
  });
});

describe('bookingEligibility — the dates read right in the member copy', () => {
  const copy = (result: BookingEligibility): string => {
    if (result.reason === null) throw new Error('expected a refusal, got an eligible result');
    return bookingRefusalCopy(
      result.reason,
      result.relevantDate === null ? null : shortDate(result.relevantDate),
    );
  };

  it('a leaver is told the day their plan ends', () => {
    const result = bookingEligibility(
      subject({ membership: snapshot({ cancelRequestedOn: d('2026-08-10') }) }),
      d('2026-09-03'),
    );
    expect(copy(result)).toBe(
      'Your plan ends 31 Aug, before this class. Start a new plan to book it.',
    );
  });

  it('a booked freeze names the day the pause ends', () => {
    const result = bookingEligibility(
      subject({ scheduledHolds: [hold('2026-08-20', '2026-08-26')] }),
      d('2026-08-22'),
    );
    expect(copy(result)).toBe(
      "Classes can't be booked during your plan's pause, which ends 26 Aug.",
    );
  });

  it('a terminated plan has simply ended — its endsOn is history, not cover', () => {
    const result = bookingEligibility(
      subject({ membership: snapshot({ status: MembershipStatus.CANCELLED }) }),
      d('2026-08-20'),
    );
    expect(copy(result)).toBe('Your plan has ended. Start a new plan to book classes.');
  });

  it('a lapsed plan whose end date lies after the class is not described by that date', () => {
    const result = bookingEligibility(
      subject({
        membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-09-30') }),
      }),
      d('2026-09-10'),
    );
    expect(copy(result)).toBe('Your plan has ended. Renew to book classes.');
  });
});

/** Every gym day from `from` to `to`, inclusive. */
function everyDay(from: string, to: string): CivilDate[] {
  const days: CivilDate[] = [];
  for (let day = d(from); day <= d(to); day = addDays(day, 1)) days.push(day);
  return days;
}

/**
 * Plans in every shape the projection has to get right, for the invariants
 * below to be checked against on every day from late July to mid-November.
 */
const GRID: ReadonlyArray<[string, BookingSubject]> = [
  ['a plain term', subject()],
  ['notice given', subject({ membership: snapshot({ cancelRequestedOn: d('2026-08-10') }) })],
  ['one freeze inside the term', subject({ scheduledHolds: [hold('2026-08-20', '2026-08-26')] })],
  [
    'two freezes inside the term',
    subject({
      scheduledHolds: [hold('2026-08-10', '2026-08-16'), hold('2026-08-24', '2026-08-30')],
    }),
  ],
  [
    'a freeze past the stored end, inside the projected one',
    subject({
      scheduledHolds: [hold('2026-08-25', '2026-08-31'), hold('2026-09-03', '2026-09-09')],
    }),
  ],
  [
    'a freeze the day after the term',
    subject({ scheduledHolds: [hold('2026-09-01', '2026-09-14')] }),
  ],
  ['a freeze after the term', subject({ scheduledHolds: [hold('2026-09-05', '2026-09-18')] })],
  [
    'notice and a freeze',
    subject({
      membership: snapshot({ cancelRequestedOn: d('2026-08-10') }),
      scheduledHolds: [hold('2026-08-20', '2026-08-26')],
    }),
  ],
  ['frozen now', subject({ membership: FROZEN_NOW })],
  [
    'frozen now, another freeze booked straight after',
    subject({ membership: FROZEN_NOW, scheduledHolds: [hold('2026-08-24', '2026-09-06')] }),
  ],
  [
    'frozen now, another freeze booked later',
    subject({ membership: FROZEN_NOW, scheduledHolds: [hold('2026-09-01', '2026-09-10')] }),
  ],
  [
    'frozen under notice',
    subject({ membership: snapshot({ ...FROZEN_NOW, cancelRequestedOn: d('2026-08-05') }) }),
  ],
  ['frozen, hold row missing', subject({ membership: snapshot({ ...FROZEN_NOW, hold: null }) })],
  ['expired', subject({ membership: snapshot({ status: MembershipStatus.EXPIRED }) })],
  [
    'expired, comp days ahead',
    subject({
      membership: snapshot({ status: MembershipStatus.EXPIRED, endsOn: d('2026-09-30') }),
    }),
  ],
  ['cancelled', subject({ membership: snapshot({ status: MembershipStatus.CANCELLED }) })],
  ['no membership', subject({ membership: null, planCode: null })],
];

const DAYS = everyDay('2026-07-25', '2026-11-15');

describe('bookingEligibility — invariants, on every day of the grid', () => {
  it.each(GRID)('%s: eligible exactly when there is no reason, and then no date', (_l, subj) => {
    for (const classDay of DAYS) {
      const result = bookingEligibility(subj, classDay);
      expect(result.eligible).toBe(result.reason === null);
      if (result.eligible) expect(result.relevantDate).toBeNull();
    }
  });

  it.each(GRID)('%s: never eligible outside coversUntil', (_l, subj) => {
    for (const classDay of DAYS) {
      const { eligible, coversUntil } = bookingEligibility(subj, classDay);
      if (eligible) expect(coversUntil !== null && classDay <= coversUntil).toBe(true);
    }
  });

  it.each(GRID)('%s: coversUntil describes the plan, not the class day', (_l, subj) => {
    const first = bookingEligibility(subj, DAYS[0]).coversUntil;
    for (const classDay of DAYS) {
      expect(bookingEligibility(subj, classDay).coversUntil).toBe(first);
    }
  });

  it.each([MembershipStatus.EXPIRED, MembershipStatus.CANCELLED])(
    'a %s plan is bookable on no day at all, whatever its dates say',
    (status) => {
      for (const endsOn of ['2026-07-31', '2026-08-31', '2026-10-31']) {
        const subj = subject({ membership: snapshot({ status, endsOn: d(endsOn) }) });
        expect(DAYS.some((classDay) => bookingEligibility(subj, classDay).eligible)).toBe(false);
      }
    },
  );

  /**
   * The spec's per-day reading, literally: a day is covered when it is on or
   * before endsOn plus the length of every booked freeze starting on or before
   * it. The ladder computes ONE end date instead (it is what the member is
   * told); this pins that the two agree on every day that is not frozen.
   */
  const coveredPerDay = (subj: BookingSubject, day: CivilDate): boolean => {
    if (subj.membership === null) return false;
    const pushedOut = subj.scheduledHolds
      .filter((h) => h.startsOn <= day)
      .reduce((total, h) => total + h.daysRequested, 0);
    return day <= addDays(subj.membership.endsOn, pushedOut);
  };

  /** Inside the running hold (FROZEN until it ends, as at the door) or a booked one. */
  const frozenOn = (subj: BookingSubject, day: CivilDate): boolean => {
    const running =
      subj.membership?.status === MembershipStatus.FROZEN ? subj.membership.hold : null;
    return (
      (running !== null && day <= running.endsOn) ||
      subj.scheduledHolds.some((h) => h.startsOn <= day && day <= h.endsOn)
    );
  };

  const projectable = GRID.filter(([, subj]) => {
    const m = subj.membership;
    return (
      m !== null &&
      (m.status === MembershipStatus.ACTIVE ||
        (m.status === MembershipStatus.FROZEN && m.hold !== null))
    );
  });

  it.each(projectable)('%s: agrees with the per-day reading on every unfrozen day', (_l, subj) => {
    for (const classDay of DAYS) {
      if (frozenOn(subj, classDay)) continue;
      expect(bookingEligibility(subj, classDay).eligible).toBe(coveredPerDay(subj, classDay));
    }
  });

  it('never mutates its subject, nor reorders the holds it was given', () => {
    const subj = subject({
      membership: FROZEN_NOW,
      scheduledHolds: [hold('2026-09-01', '2026-09-10'), hold('2026-08-24', '2026-08-30')],
    });
    const before = JSON.stringify(subj);
    for (const classDay of DAYS) bookingEligibility(subj, classDay);
    expect(JSON.stringify(subj)).toBe(before);
  });
});

describe('booking-eligibility.ts stays pure', () => {
  const source = readFileSync(join(__dirname, 'booking-eligibility.ts'), 'utf8');

  it('reads no clock', () => {
    expect(source).not.toMatch(/new Date\(/);
    expect(source).not.toMatch(/Date\.now\(/);
  });

  it('reads no config service and no Prisma client at runtime', () => {
    expect(source).not.toMatch(/GymConfigService/);
    expect(source).not.toMatch(/PrismaService/);
    expect(source.match(/^import .*'@prisma\/client';$/gm) ?? []).toEqual([
      "import type { UserStatus } from '@prisma/client';",
    ]);
  });

  it('is not a Nest provider', () => {
    expect(source).not.toMatch(/@Injectable/);
  });
});
