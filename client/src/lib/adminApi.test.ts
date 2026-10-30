import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from './api';
import { adminApi } from './adminApi';

/**
 * Thin-wrapper contract tests: each of these asserts nothing but the path,
 * method and body `adminApi` hands to `apiFetch` — not envelope handling
 * (that's `api.test.ts`'s job) and not server behaviour. A wrapper that sends
 * the wrong path or forgets a field is exactly what this catches.
 */
describe('adminApi — C4 wrappers', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('members() forwards the deleted filter', async () => {
    await adminApi.members({ page: 1, limit: 20, deleted: true });
    expect(apiFetch).toHaveBeenCalledWith('/members?page=1&limit=20&deleted=true');
  });

  it('members() omits deleted when unset, matching every other optional filter', async () => {
    await adminApi.members({ page: 1, limit: 20 });
    expect(apiFetch).toHaveBeenCalledWith('/members?page=1&limit=20');
  });

  it('members() forwards sort and membershipStatus — the two the merge added', async () => {
    await adminApi.members({ page: 1, limit: 15, sort: 'ending', membershipStatus: 'FROZEN' });
    // `qs()` preserves the caller's key order, so this asserts the query
    // string verbatim rather than a set of params.
    expect(apiFetch).toHaveBeenCalledWith(
      '/members?page=1&limit=15&sort=ending&membershipStatus=FROZEN',
    );
  });

  it('members() omits sort and membershipStatus when unset', async () => {
    await adminApi.members({ page: 1, limit: 15, standing: 'ACTIVE' });
    expect(apiFetch).toHaveBeenCalledWith('/members?page=1&limit=15&standing=ACTIVE');
  });

  /** The KPI tiles. One request where the old screen fired four. */
  it('memberCounts() hits /members/counts with only the filters it shares with the list', async () => {
    await adminApi.memberCounts({ search: 'reyes', planCode: 'ANNUAL' });
    expect(apiFetch).toHaveBeenCalledWith('/members/counts?search=reyes&planCode=ANNUAL');
  });

  it('memberCounts() sends a bare path when nothing is filtered', async () => {
    await adminApi.memberCounts({});
    expect(apiFetch).toHaveBeenCalledWith('/members/counts');
  });

  it('payments() forwards userId — the C4 gap the brief calls out', async () => {
    await adminApi.payments({ page: 1, limit: 20, userId: 'u1' });
    expect(apiFetch).toHaveBeenCalledWith('/payments?page=1&limit=20&userId=u1');
  });

  it('createMember() posts to /members', async () => {
    const body = {
      firstName: 'Jon',
      lastName: 'Snow',
      email: 'jon@wall.example',
      dateOfBirth: '1995-05-05',
    };
    await adminApi.createMember(body);
    expect(apiFetch).toHaveBeenCalledWith('/members', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('updateMember() patches /members/:id', async () => {
    await adminApi.updateMember('m1', { firstName: 'Jonathan' });
    expect(apiFetch).toHaveBeenCalledWith('/members/m1', {
      method: 'PATCH',
      body: JSON.stringify({ firstName: 'Jonathan' }),
    });
  });

  it('suspendMember() posts the reason', async () => {
    await adminApi.suspendMember('m1', 'no-show three times');
    expect(apiFetch).toHaveBeenCalledWith('/members/m1/suspend', {
      method: 'POST',
      body: JSON.stringify({ reason: 'no-show three times' }),
    });
  });

  it('reactivateMember() sends no meaningful body', async () => {
    await adminApi.reactivateMember('m1');
    expect(apiFetch).toHaveBeenCalledWith('/members/m1/reactivate', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  });

  it('deleteMember() DELETEs /members/:id', async () => {
    await adminApi.deleteMember('m1');
    expect(apiFetch).toHaveBeenCalledWith('/members/m1', { method: 'DELETE' });
  });

  it('restoreMember() POSTs to /members/:id/restore with no meaningful body', async () => {
    await adminApi.restoreMember('m1');
    expect(apiFetch).toHaveBeenCalledWith('/members/m1/restore', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  });

  it('changeMemberRole() posts the role', async () => {
    await adminApi.changeMemberRole('m1', 'COACH');
    expect(apiFetch).toHaveBeenCalledWith('/members/m1/role', {
      method: 'POST',
      body: JSON.stringify({ role: 'COACH' }),
    });
  });

  it('changeMemberRole() sends the confirmation reason alongside the role', async () => {
    await adminApi.changeMemberRole('m1', 'ADMIN', 'covering the owner');
    expect(apiFetch).toHaveBeenCalledWith('/members/m1/role', {
      method: 'POST',
      body: JSON.stringify({ role: 'ADMIN', reason: 'covering the owner' }),
    });
  });

  it('resendInvite() posts to resend-invite', async () => {
    await adminApi.resendInvite('m1');
    expect(apiFetch).toHaveBeenCalledWith('/members/m1/resend-invite', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  });

  it('changeMemberEmail() posts the new address to change-email', async () => {
    await adminApi.changeMemberEmail('id-1', 'new@example.com');
    expect(apiFetch).toHaveBeenCalledWith('/members/id-1/change-email', {
      method: 'POST',
      body: JSON.stringify({ email: 'new@example.com' }),
    });
  });

  it('sellMembership() posts to /memberships', async () => {
    const body = { userId: 'u1', planCode: 'MONTHLY', method: 'CASH' as const };
    await adminApi.sellMembership(body);
    expect(apiFetch).toHaveBeenCalledWith('/memberships', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('renewMembership() posts to /memberships/:id/renew, no userId', async () => {
    const body = { planCode: 'MONTHLY', method: 'GCASH' as const, reference: 'GC-1' };
    await adminApi.renewMembership('mem1', body);
    expect(apiFetch).toHaveBeenCalledWith('/memberships/mem1/renew', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('freezeMembership() posts to /memberships/:id/freeze', async () => {
    const body = { startsOn: '2026-09-01', endsOn: '2026-09-15', reason: 'medical leave' };
    await adminApi.freezeMembership('mem1', body);
    expect(apiFetch).toHaveBeenCalledWith('/memberships/mem1/freeze', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('cancelMembership() sends confirm: true, matching voidCheckIn idiom', async () => {
    await adminApi.cancelMembership('mem1', 'member requested outright cancellation');
    expect(apiFetch).toHaveBeenCalledWith('/memberships/mem1/cancel', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, reason: 'member requested outright cancellation' }),
    });
  });

  it('recordPayment() posts to /payments', async () => {
    const body = {
      purpose: 'WALK_IN' as const,
      planCode: 'WALKIN',
      grossCentavos: 9000,
      method: 'CASH' as const,
    };
    await adminApi.recordPayment(body);
    expect(apiFetch).toHaveBeenCalledWith('/payments', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('voidPayment() sends confirm, reason and kind', async () => {
    await adminApi.voidPayment('pay1', 'entered twice', 'VOID');
    expect(apiFetch).toHaveBeenCalledWith('/payments/pay1/void', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, reason: 'entered twice', kind: 'VOID' }),
    });
  });

  it('checkIns() forwards a member history filter to GET /check-ins', async () => {
    await adminApi.checkIns({ userId: 'u1', page: 1, limit: 20 });
    expect(apiFetch).toHaveBeenCalledWith('/check-ins?userId=u1&page=1&limit=20');
  });

  it('checkIns() defaults to no params', async () => {
    await adminApi.checkIns();
    expect(apiFetch).toHaveBeenCalledWith('/check-ins');
  });

  /**
   * `/reports/memberships`, NOT `/memberships?from=…&to=…`. The second path
   * exists and would 200 — `Membership.userId` is @unique, so it would answer
   * a historical question with every member's CURRENT term, which is the one
   * wrong answer that survives review. A path-contract test is the only place
   * that distinction is mechanically checkable.
   */
  it('reportMemberships() reads the event log, not the membership table', async () => {
    await adminApi.reportMemberships('2026-09-01', '2026-09-22');
    expect(apiFetch).toHaveBeenCalledWith('/reports/memberships?from=2026-09-01&to=2026-09-22');
  });

  it('walkInStats() sends both inclusive bounds', async () => {
    await adminApi.walkInStats('2026-09-16', '2026-09-22');
    expect(apiFetch).toHaveBeenCalledWith('/reports/walk-ins?from=2026-09-16&to=2026-09-22');
  });

  /**
   * `groupBy` is on the query string, and the server's DTO now declares it.
   * It used to be read via a second `@Query('groupBy')` beside a validated
   * `@Query()` that did not list it, and the global pipe's
   * `forbidNonWhitelisted` turned every one of these calls into a
   * `400 property groupBy should not exist`.
   */
  it('revenue() sends groupBy, defaulting to month', async () => {
    await adminApi.revenue('2026-09-01', '2026-09-22');
    expect(apiFetch).toHaveBeenCalledWith(
      '/reports/revenue?from=2026-09-01&to=2026-09-22&groupBy=month',
    );

    await adminApi.revenue('2026-09-01', '2026-09-22', 'plan');
    expect(apiFetch).toHaveBeenLastCalledWith(
      '/reports/revenue?from=2026-09-01&to=2026-09-22&groupBy=plan',
    );
  });

  it('payment() reads one payment from GET /payments/:id', async () => {
    await adminApi.payment('pay1');
    expect(apiFetch).toHaveBeenCalledWith('/payments/pay1');
  });

  /** `confirm: true` is the client's half of `assertConfirmed`. */
  it('amendPayment() posts confirm alongside the changed fields', async () => {
    await adminApi.amendPayment('pay1', { reason: 'rang the wrong plan', planCode: 'MONTHLY' });
    expect(apiFetch).toHaveBeenCalledWith('/payments/pay1/amend', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, reason: 'rang the wrong plan', planCode: 'MONTHLY' }),
    });
  });

  it('archivePayment() and unarchivePayment() post to their own routes', async () => {
    await adminApi.archivePayment('pay1');
    expect(apiFetch).toHaveBeenCalledWith('/payments/pay1/archive', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    await adminApi.unarchivePayment('pay1');
    expect(apiFetch).toHaveBeenCalledWith('/payments/pay1/unarchive', {
      method: 'POST',
      body: JSON.stringify({}),
    });
  });

  it('payments() renders every register filter into the query string', async () => {
    await adminApi.payments({
      page: 1,
      limit: 20,
      from: '2026-09-01',
      to: '2026-09-22',
      status: 'RECORDED',
      planCode: 'WALKIN',
      archived: true,
    });
    expect(apiFetch).toHaveBeenCalledWith(
      '/payments?page=1&limit=20&from=2026-09-01&to=2026-09-22&status=RECORDED&planCode=WALKIN&archived=true',
    );
  });

  /** `qs()` drops `''`, which is how "All" sends no date bound at all. */
  it('payments() omits an unset range rather than sending empty bounds', async () => {
    await adminApi.payments({ page: 1, limit: 20, from: '', to: '' });
    expect(apiFetch).toHaveBeenCalledWith('/payments?page=1&limit=20');
  });

  /** An account-less guest gives an email at the counter (owner, 2026-10-14). */
  it('sellWalkIn() posts the guest email with the rest of the sale', async () => {
    const body = {
      kind: 'WALK_IN' as const,
      guestName: 'Ana',
      guestEmail: 'ana@example.com',
      guestWaiverAccepted: true,
    };
    await adminApi.sellWalkIn(body);
    expect(apiFetch).toHaveBeenCalledWith('/front-desk/walk-ins', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('checkInGuest() returns the email the visit recorded, for "Make member"', async () => {
    const guest = {
      guestName: 'Ana Cruz',
      guestPhone: null,
      guestEmail: 'ana@example.com',
      guestEmergencyContact: null,
    };
    vi.mocked(apiFetch).mockResolvedValueOnce(guest);
    const read = await adminApi.checkInGuest('ci1');
    expect(apiFetch).toHaveBeenCalledWith('/front-desk/check-ins/ci1/guest');
    expect(read.guestEmail).toBe('ana@example.com');
  });
});

/**
 * The console's classes screen (2026-10-11): paging the timetable, the
 * register, and the desk adding or removing a member by hand.
 */
describe('adminApi — classes and the register', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  /** A class as the API before 2026-10-11 sent it: no `waitlistCount`. */
  const OLD_SESSION = {
    id: 's1',
    title: 'HIIT',
    description: null,
    coachId: 'c1',
    coachName: 'Ana Cruz',
    startsAt: '2026-10-14T10:00:00.000Z',
    endsAt: '2026-10-14T11:00:00.000Z',
    businessDate: '2026-10-14',
    capacity: 16,
    bookedCount: 16,
    seatsLeft: 0,
    isFull: true,
    cancelledAt: null,
    cancelReason: null,
  };
  const MEMBER = { firstName: 'Maria', lastName: 'Santos', memberCode: 'ABC123' };
  /** A register row as the API before 2026-10-11 sent it. */
  const OLD_ROW = { bookingId: 'b1', status: 'WAITLISTED', member: MEMBER };
  const NEW_FIELDS_DEFAULTED = {
    bookedAt: '',
    waitlistPosition: null,
    addedByStaff: false,
    markedAt: null,
    markedBy: null,
  };

  /** Without from/to the server shows today onwards, and past classes are unreachable. */
  it('classSessions() forwards the window and the coach filter', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([]);
    await adminApi.classSessions({ from: '2026-09-27', to: '2026-10-10', coachId: 'c1' });
    expect(apiFetch).toHaveBeenCalledWith(
      '/class-sessions?from=2026-09-27&to=2026-10-10&coachId=c1',
    );
  });

  it('classSessions() sends a bare path when nothing is filtered', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([]);
    await adminApi.classSessions();
    expect(apiFetch).toHaveBeenCalledWith('/class-sessions');
  });

  /**
   * The deploy window: the new console briefly reads the old API. A missing
   * count is 0 — never "undefined waiting", never NaN people told.
   */
  it('reads a class with no waitlist count as nobody waiting, and keeps a real count', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([OLD_SESSION, { ...OLD_SESSION, waitlistCount: 3 }]);
    const rows = await adminApi.classSessions();
    expect(rows.map((row) => row.waitlistCount)).toEqual([0, 3]);
    expect(rows[0]).toEqual({ ...OLD_SESSION, waitlistCount: 0 });

    for (const write of [
      () => adminApi.updateClassSession('s1', { capacity: 18 }),
      () => adminApi.cancelClassSession('s1', 'Coach unwell'),
      () =>
        adminApi.createClassSession({
          title: 'HIIT',
          coachId: 'c1',
          startsAt: OLD_SESSION.startsAt,
          endsAt: OLD_SESSION.endsAt,
          capacity: 16,
        }),
    ]) {
      vi.mocked(apiFetch).mockResolvedValueOnce(OLD_SESSION);
      expect((await write()).waitlistCount).toBe(0);
    }
  });

  /** "Repeat weekly" (2026-10-30): one POST, the first class back, and the series with it. */
  it('createClassSession() sends repeatWeeks only when asked, and reads either API as a series', async () => {
    const body = {
      title: 'HIIT',
      coachId: 'c1',
      startsAt: OLD_SESSION.startsAt,
      endsAt: OLD_SESSION.endsAt,
      capacity: 16,
    };
    // The API before it answered with the class alone: a series of one.
    vi.mocked(apiFetch).mockResolvedValueOnce(OLD_SESSION);
    const single = await adminApi.createClassSession(body);
    expect(apiFetch).toHaveBeenLastCalledWith('/admin/class-sessions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    expect([single.id, single.count, single.sessions.map((s) => s.id)]).toEqual(['s1', 1, ['s1']]);

    const first = { ...OLD_SESSION, waitlistCount: 0 };
    const second = { ...first, id: 's2', businessDate: '2026-10-21' };
    vi.mocked(apiFetch).mockResolvedValueOnce({ ...first, count: 2, sessions: [first, second] });
    const series = await adminApi.createClassSession({ ...body, repeatWeeks: 2 });
    expect(apiFetch).toHaveBeenLastCalledWith('/admin/class-sessions', {
      method: 'POST',
      body: JSON.stringify({ ...body, repeatWeeks: 2 }),
    });
    expect(series).toMatchObject({ id: 's1', businessDate: '2026-10-14', count: 2 });
    expect(series.sessions.map((s) => s.businessDate)).toEqual(['2026-10-14', '2026-10-21']);
  });

  it('classRegister() reads the register under the session', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([]);
    await adminApi.classRegister('s1');
    expect(apiFetch).toHaveBeenCalledWith('/class-sessions/s1/register');
  });

  /** Read raw, `markedBy.firstName` crashed the register and badges read "#undefined". */
  it('classRegister() gives an old row null markers, no queue place and no desk add', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce([OLD_ROW]);
    expect(await adminApi.classRegister('s1')).toEqual([{ ...OLD_ROW, ...NEW_FIELDS_DEFAULTED }]);
  });

  it('markAttendance() posts the mark to the staff route', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ bookingId: 'b1', status: 'NO_SHOW' });
    await adminApi.markAttendance('b1', false);
    expect(apiFetch).toHaveBeenCalledWith('/admin/class-sessions/bookings/b1/attendance', {
      method: 'POST',
      body: JSON.stringify({ attended: false }),
    });
  });

  it('markAttendance() reads an old answer as a mark with no marker, and keeps a new one', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ bookingId: 'b1', status: 'NO_SHOW' });
    expect(await adminApi.markAttendance('b1', false)).toEqual({
      bookingId: 'b1',
      status: 'NO_SHOW',
      markedAt: null,
      markedBy: null,
    });

    const answer = {
      bookingId: 'b1',
      status: 'ATTENDED',
      markedAt: '2026-10-14T10:05:00.000Z',
      markedBy: { firstName: 'Ana', lastName: 'Cruz' },
    };
    vi.mocked(apiFetch).mockResolvedValueOnce(answer);
    expect(await adminApi.markAttendance('b1', true)).toEqual(answer);
  });

  /** The member is named in the body; the path names the class. */
  it('addToClass() posts the member to the session’s bookings', async () => {
    vi.mocked(apiFetch).mockResolvedValueOnce({ ...OLD_ROW, status: 'BOOKED' });
    const entry = await adminApi.addToClass('s1', 'u1');
    expect(apiFetch).toHaveBeenCalledWith('/admin/class-sessions/s1/bookings', {
      method: 'POST',
      body: JSON.stringify({ userId: 'u1' }),
    });
    expect(entry).toEqual({ ...OLD_ROW, status: 'BOOKED', ...NEW_FIELDS_DEFAULTED });
  });

  /**
   * A POST with a reason, not a DELETE: the reason is required and the member
   * reads it, and a DELETE body is the one thing proxies are free to drop.
   */
  it('removeFromClass() posts the reason to the booking’s remove route', async () => {
    await adminApi.removeFromClass('b1', 'Booked twice by mistake');
    expect(apiFetch).toHaveBeenCalledWith('/admin/class-sessions/bookings/b1/remove', {
      method: 'POST',
      body: JSON.stringify({ reason: 'Booked twice by mistake' }),
    });
  });
});

describe('adminApi — assistant settings', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it('assistantSettings() reads /admin/assistant', async () => {
    await adminApi.assistantSettings();
    expect(apiFetch).toHaveBeenCalledWith('/admin/assistant');
  });

  it('saveAssistantInstructions() PUTs the whole text', async () => {
    await adminApi.saveAssistantInstructions('Be brief.');
    expect(apiFetch).toHaveBeenCalledWith('/admin/assistant', {
      method: 'PUT',
      body: JSON.stringify({ instructions: 'Be brief.' }),
    });
  });

  it('resetAssistantInstructions() DELETEs', async () => {
    await adminApi.resetAssistantInstructions();
    expect(apiFetch).toHaveBeenCalledWith('/admin/assistant', { method: 'DELETE' });
  });

  it('tryAssistantDraft() POSTs the draft and the question', async () => {
    await adminApi.tryAssistantDraft('Be brief.', 'When do you open?');
    expect(apiFetch).toHaveBeenCalledWith('/admin/assistant/test', {
      method: 'POST',
      body: JSON.stringify({ instructions: 'Be brief.', question: 'When do you open?' }),
    });
  });
});
