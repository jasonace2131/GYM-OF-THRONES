import { describe, expect, it } from 'vitest';
import type { ClassSession } from '@/lib/classes';
import {
  canCancelClass,
  canEditClass,
  classFormProblem,
  createBody,
  draftFor,
  instantsOf,
  patchFor,
} from './coachClasses';

/** Coaches run their own classes (owner, 2026-10-23): the form's decisions. */

const ME = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
/** Mon 14 Sep 2026, 10:00 Manila. */
const NOW = new Date('2026-09-14T02:00:00.000Z');

const session = (over: Partial<ClassSession> = {}): ClassSession =>
  ({
    id: 's1',
    title: 'Spin',
    description: null,
    coachId: ME,
    coachName: 'Ana Cruz',
    startsAt: '2026-09-16T10:00:00.000Z', // Wed 18:00 Manila
    endsAt: '2026-09-16T11:00:00.000Z',
    businessDate: '2026-09-16',
    capacity: 12,
    bookedCount: 3,
    seatsLeft: 9,
    isFull: false,
    waitlistCount: 0,
    cancelledAt: null,
    cancelReason: null,
    ...over,
  }) as ClassSession;

describe('the coach class form', () => {
  it('starts a new class on the day in view at 6pm, an hour, 16 places', () => {
    expect(draftFor(null, '2026-09-18')).toEqual({
      title: '',
      date: '2026-09-18',
      start: '18:00',
      minutes: 60,
      capacity: 16,
    });
  });

  it('opens an existing class in gym time', () => {
    expect(draftFor(session(), '2026-09-14')).toEqual({
      title: 'Spin',
      date: '2026-09-16',
      start: '18:00',
      minutes: 60,
      capacity: 12,
    });
  });

  it('turns the gym-local date and time into instants, whatever the device zone', () => {
    expect(instantsOf({ ...draftFor(null, '2026-09-18'), minutes: 45 })).toEqual({
      startsAt: '2026-09-18T10:00:00.000Z',
      endsAt: '2026-09-18T10:45:00.000Z',
    });
    expect(instantsOf({ ...draftFor(null, ''), date: '' })).toBeNull();
  });

  it('says what is missing or out of range, as the server would', () => {
    const ok = { ...draftFor(null, '2026-09-18'), title: 'Yoga' };
    expect(classFormProblem(ok)).toBeNull();
    expect(classFormProblem({ ...ok, title: '  ' })).toBe('Give the class a name.');
    expect(classFormProblem({ ...ok, title: 'x'.repeat(81) })).toBe(
      'Keep the name to 80 characters.',
    );
    expect(classFormProblem({ ...ok, date: '' })).toBe('Pick a date and a start time.');
    expect(classFormProblem({ ...ok, minutes: 5 })).toBe('A class runs 10 to 300 minutes.');
    expect(classFormProblem({ ...ok, capacity: 0 })).toBe('Places must be 1 to 500.');
  });

  it('creates with the coach fixed to the caller', () => {
    const draft = { ...draftFor(null, '2026-09-18'), title: ' Yoga ' };
    expect(createBody(draft, ME)).toEqual({
      title: 'Yoga',
      coachId: ME,
      startsAt: '2026-09-18T10:00:00.000Z',
      endsAt: '2026-09-18T11:00:00.000Z',
      capacity: 16,
    });
  });

  it('edits with only what changed, and never the coach', () => {
    const s = session();
    expect(patchFor(s, draftFor(s, '2026-09-14'))).toEqual({});
    expect(patchFor(s, { ...draftFor(s, '2026-09-14'), title: 'Spin Express', capacity: 14 })).toEqual(
      { title: 'Spin Express', capacity: 14 },
    );
    expect(patchFor(s, { ...draftFor(s, '2026-09-14'), start: '19:00' })).toEqual({
      startsAt: '2026-09-16T11:00:00.000Z',
      endsAt: '2026-09-16T12:00:00.000Z',
    });
  });

  it('offers edit and cancel on my own live classes only', () => {
    expect(canEditClass(session(), ME, NOW)).toBe(true);
    expect(canCancelClass(session(), ME, NOW)).toBe(true);
    expect(canEditClass(session({ coachId: OTHER }), ME, NOW)).toBe(false);
    expect(canCancelClass(session({ coachId: OTHER }), ME, NOW)).toBe(false);
    const cancelled = session({ cancelledAt: '2026-09-14T01:00:00.000Z' });
    expect(canEditClass(cancelled, ME, NOW)).toBe(false);
    expect(canCancelClass(cancelled, ME, NOW)).toBe(false);
    // Running: may still be edited (the end moved later), never cancelled.
    const running = new Date('2026-09-16T10:30:00.000Z');
    expect(canEditClass(session(), ME, running)).toBe(true);
    expect(canCancelClass(session(), ME, running)).toBe(false);
    // Finished: neither.
    expect(canEditClass(session(), ME, new Date('2026-09-16T11:00:00.000Z'))).toBe(false);
    expect(canEditClass(session(), null, NOW)).toBe(false);
  });
});
