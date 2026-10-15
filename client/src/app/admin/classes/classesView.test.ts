import { describe, expect, it } from 'vitest';
import {
  TIMETABLE_WINDOW_DAYS,
  cancelConsequence,
  editConsequence,
  holdersPhrase,
  holdersSentence,
  patchNotifies,
  raiseMovesUp,
  readCoachFilter,
  readWindowStart,
  removeConsequence,
  stepWindow,
  timetableHref,
  timetableWindow,
  windowContaining,
} from './classesView';

/** A gym-local wall-clock time as an instant (Manila is UTC+8, no DST). */
const at = (day: string, hhmm: string): Date => new Date(`${day}T${hhmm}:00+08:00`);

const TODAY = '2026-10-11';
const COACH = '5f0c3a8e-2b4d-4c1e-9a7b-3d2e1f0a9b8c';

describe('the window of days', () => {
  it('is two weeks, both ends included', () => {
    expect(TIMETABLE_WINDOW_DAYS).toBe(14);
    expect(timetableWindow(TODAY)).toEqual({ from: '2026-10-11', to: '2026-10-24' });
  });

  it('reads ?from= back as a real day, or falls back to today', () => {
    expect(readWindowStart(null, TODAY)).toBe(TODAY);
    expect(readWindowStart('2026-09-27', TODAY)).toBe('2026-09-27');
    expect(readWindowStart('lol', TODAY)).toBe(TODAY);
    expect(readWindowStart('2026-02-30', TODAY)).toBe(TODAY);
  });

  it('steps a whole window at a time, across a month end', () => {
    expect(stepWindow(TODAY, -1)).toBe('2026-09-27');
    expect(stepWindow(TODAY, 1)).toBe('2026-10-25');
    expect(stepWindow(TODAY, 0)).toBe(TODAY);
  });

  /** Where a class just scheduled outside the visible fortnight is found. */
  it('finds the window containing a day, on the same grid', () => {
    expect(windowContaining(TODAY, '2026-10-24')).toBe(TODAY);
    expect(windowContaining(TODAY, '2026-10-25')).toBe('2026-10-25');
    expect(windowContaining(TODAY, '2026-11-20')).toBe('2026-11-08');
    expect(windowContaining(TODAY, '2026-10-10')).toBe('2026-09-27');
  });
});

describe('the URL', () => {
  it('keeps only a coach id the API would accept', () => {
    expect(readCoachFilter(COACH)).toBe(COACH);
    expect(readCoachFilter(null)).toBe('');
    expect(readCoachFilter('ana')).toBe('');
  });

  /** A bare /admin/classes follows today, so a screen left open moves on at midnight. */
  it('leaves the defaults out of the address', () => {
    expect(timetableHref(TODAY, '', TODAY)).toBe('/admin/classes');
    expect(timetableHref('2026-09-27', '', TODAY)).toBe('/admin/classes?from=2026-09-27');
    expect(timetableHref(TODAY, COACH, TODAY)).toBe(`/admin/classes?coach=${COACH}`);
    expect(timetableHref('2026-10-25', COACH, TODAY)).toBe(
      `/admin/classes?from=2026-10-25&coach=${COACH}`,
    );
  });
});

describe('who is told', () => {
  it('names everybody holding a place, in one grammatical phrase', () => {
    expect(holdersPhrase(0, 0)).toBeNull();
    expect(holdersPhrase(1, 0)).toBe('the one person booked gets');
    expect(holdersPhrase(0, 1)).toBe('the one person waiting gets');
    expect(holdersPhrase(5, 0)).toBe('all 5 people booked get');
    expect(holdersPhrase(5, 2)).toBe('all 7 people booked or waiting get');
  });

  it('opens the edit form with who is already in the class', () => {
    expect(holdersSentence(0, 0)).toBeNull();
    expect(holdersSentence(1, 0)).toBe('1 person has booked this.');
    expect(holdersSentence(5, 2)).toBe('5 people have booked this and 2 are waiting.');
    expect(holdersSentence(16, 1)).toBe('16 people have booked this and 1 is waiting.');
    expect(holdersSentence(0, 3)).toBe('3 people are waiting for a place.');
  });

  /**
   * It used to say "see your reason" and nothing about being told. The count
   * is the server's recipients: every booking not itself cancelled — seats
   * (an early register mark included) plus the waitlist.
   */
  it('says a cancellation reaches everybody booked or waiting as a notice', () => {
    expect(cancelConsequence(0, 0)).toBe(
      'The class stays on the timetable marked cancelled, with your reason.',
    );
    expect(cancelConsequence(16, 2)).toBe(
      'The class stays on the timetable marked cancelled, and all 18 people booked or waiting get a notice in the app with your reason.',
    );
  });

  it('counts only the time, the coach and the name as changes people are told about', () => {
    expect(patchNotifies({ title: 'HIIT' })).toBe(true);
    expect(patchNotifies({ coachId: COACH })).toBe(true);
    expect(patchNotifies({ startsAt: at(TODAY, '18:00').toISOString() })).toBe(true);
    expect(patchNotifies({ endsAt: at(TODAY, '19:00').toISOString() })).toBe(true);
    expect(patchNotifies({ capacity: 20 })).toBe(false);
    expect(patchNotifies({})).toBe(false);
  });
});

describe('editing a class', () => {
  const full = {
    capacity: 16,
    bookedCount: 16,
    waitlistCount: 3,
    startsAt: at('2026-10-14', '18:00').toISOString(),
  };
  const morning = at('2026-10-14', '09:00');

  it('moves up to the new places off the waitlist, before the cutoff', () => {
    expect(raiseMovesUp(full, { capacity: 18 }, morning)).toBe(2);
    expect(raiseMovesUp(full, { capacity: 30 }, morning)).toBe(3);
    expect(raiseMovesUp(full, { capacity: 16 }, morning)).toBe(0);
    expect(raiseMovesUp(full, { capacity: 12 }, morning)).toBe(0);
  });

  it('moves nobody once the waitlist has closed — judged on the new start', () => {
    expect(raiseMovesUp(full, { capacity: 18 }, at('2026-10-14', '16:00'))).toBe(0);
    // Moved to tomorrow: the cutoff moves with it, so the queue still moves up.
    expect(
      raiseMovesUp(
        full,
        { capacity: 18, startsAt: at('2026-10-15', '18:00').toISOString() },
        at('2026-10-14', '16:00'),
      ),
    ).toBe(2);
  });

  it('tells everybody in the class about a new time, with the waitlist as a fact', () => {
    expect(
      editConsequence(
        full,
        { startsAt: at('2026-10-14', '19:00').toISOString(), capacity: 18 },
        morning,
      ),
    ).toEqual({
      consequence: 'All 19 people booked or waiting get a notice in the app with the new details.',
      facts: [
        'The new places go to up to 2 eligible people on the waitlist, in queue order, and each is told in the app.',
      ],
    });
  });

  /**
   * A member who joined the waitlist themselves and whose plan no longer
   * covers the class is passed over, so no sentence names who moves in.
   */
  it('makes the waitlist the sentence when nobody else is told, promising no one by name', () => {
    expect(editConsequence(full, { capacity: 17 }, morning)).toEqual({
      consequence:
        'The new place goes to the next eligible person on the waitlist, who is told in the app.',
      facts: [],
    });
    expect(editConsequence({ ...full, waitlistCount: 1 }, { capacity: 20 }, morning)).toEqual({
      consequence:
        'The person waiting moves into a new place if they are still eligible, and is told in the app.',
      facts: [],
    });
    expect(editConsequence(full, { capacity: 17 }, at('2026-10-14', '17:00'))).toEqual({
      consequence:
        'The waitlist has closed, so nobody moves up by themselves: the new places go to whoever books first.',
      facts: [],
    });
  });

  /** As the server sends it: a waitlist place on a running class is no place at all. */
  it('tells only the seats about a change to a class already running', () => {
    expect(
      editConsequence(
        full,
        { endsAt: at('2026-10-14', '19:30').toISOString() },
        at('2026-10-14', '18:20'),
      ),
    ).toEqual({
      consequence: 'All 16 people booked get a notice in the app with the new details.',
      facts: [],
    });
  });

  it('falls back to the timetable when nobody holds a place', () => {
    const empty = { ...full, bookedCount: 0, waitlistCount: 0 };
    expect(editConsequence(empty, { title: 'Spin' }, morning)).toEqual({
      consequence: 'Members see the new details on the timetable straight away.',
      facts: [],
    });
  });
});

describe('removing a member', () => {
  const session = { startsAt: at('2026-10-14', '18:00').toISOString(), waitlistCount: 2 };

  it('takes a waitlisted member off the queue', () => {
    expect(
      removeConsequence({ status: 'WAITLISTED' }, 'Maria', session, at('2026-10-14', '09:00')),
    ).toBe('Maria comes off the waitlist and gets a notice in the app with your reason.');
  });

  it('gives a freed seat to the queue before the cutoff, and to whoever books after it', () => {
    // "Eligible": the first in the queue may be passed over for their plan.
    expect(
      removeConsequence({ status: 'BOOKED' }, 'Maria', session, at('2026-10-14', '09:00')),
    ).toBe(
      "Maria's place goes to the next eligible person on the waitlist, and Maria gets a notice in the app with your reason.",
    );
    expect(
      removeConsequence({ status: 'BOOKED' }, 'Maria', session, at('2026-10-14', '16:30')),
    ).toBe(
      "Maria's place opens up for somebody else to book, and Maria gets a notice in the app with your reason.",
    );
    expect(
      removeConsequence(
        { status: 'BOOKED' },
        'Maria',
        { ...session, waitlistCount: 0 },
        at('2026-10-14', '09:00'),
      ),
    ).toBe(
      "Maria's place opens up for somebody else to book, and Maria gets a notice in the app with your reason.",
    );
  });
});
