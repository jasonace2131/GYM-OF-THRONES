import { MembershipStatus } from '@got/shared';
import { asCivilDate } from '../common/time/gym-time';
import { accessVerdict, type MembershipSnapshot } from '../membership/access-verdict';
import {
  SELLABLE_DENIAL_REASONS,
  cursorFrom,
  toActiveCheckIn,
  toCheckInRecord,
  toDeskArrival,
  toDeskDenial,
  toDeskGuest,
  toDeskMember,
  toDeskStationStatus,
  type CheckInRecordSource,
  type DeskCheckInSource,
} from './desk.presenter';

const NOW = new Date('2026-08-20T10:14:00.000Z');
const TODAY = asCivilDate('2026-08-20');
const CFG = { expiringSoonDays: 7, graceAdmissionsMax: 3 };

const USER = {
  id: 'u-1',
  firstName: 'Ana',
  lastName: 'Reyes',
  memberCode: '7K3M9Q',
  avatarUrl: 'https://cdn.example/ana.jpg',
};

function snapshot(overrides: Partial<MembershipSnapshot> = {}): MembershipSnapshot {
  return {
    status: MembershipStatus.ACTIVE,
    startsOn: asCivilDate('2026-08-01'),
    endsOn: asCivilDate('2026-09-14'),
    graceDays: 3,
    graceAdmissionsThisTerm: 0,
    cancelRequestedOn: null,
    planName: 'Monthly',
    planPriceCentavos: 80000,
    hold: null,
    ...overrides,
  };
}

const verdict = (m: MembershipSnapshot | null): ReturnType<typeof accessVerdict> =>
  accessVerdict({ userStatus: 'ACTIVE', membership: m, dayPassValidToday: false }, TODAY, CFG);

function checkInRow(overrides: Partial<DeskCheckInSource> = {}): DeskCheckInSource {
  return {
    id: 'c-1',
    occurredAt: new Date('2026-08-20T10:00:00.000Z'),
    endedAt: null,
    verdict: 'ALLOWED',
    method: 'STATION_QR',
    offSiteOrigin: false,
    photoOnFileAtTime: true,
    station: { code: '9F2K', name: 'Front desk' },
    ...overrides,
  };
}

/**
 * The single most important group in this file. `DeskMember` streams
 * continuously to a PC in a public lobby and stays on screen all day, so its
 * FIELD SET is the security property — not any individual value.
 */
describe('DeskMember is a privacy boundary', () => {
  it('carries exactly the nine fields the console needs and no more', () => {
    const member = toDeskMember(USER, snapshot(), verdict(snapshot()));
    expect(Object.keys(member).sort()).toEqual([
      'avatarUrl',
      'daysRemaining',
      'endsOn',
      'firstName',
      'lastName',
      'memberCode',
      'planName',
      'status',
      'userId',
    ]);
  });

  it('never carries contact details, money or body metrics', () => {
    const member = toDeskMember(USER, snapshot(), verdict(snapshot()));
    const serialised = JSON.stringify(member);
    for (const leak of [
      'email',
      'phone',
      'address',
      'centavos',
      'heightCm',
      'weightKg',
      'PriceCentavos',
    ]) {
      expect(serialised).not.toContain(leak);
    }
  });

  it('projects the plan, the term and the live day count', () => {
    const member = toDeskMember(USER, snapshot(), verdict(snapshot()));
    expect(member).toEqual({
      userId: 'u-1',
      firstName: 'Ana',
      lastName: 'Reyes',
      memberCode: '7K3M9Q',
      avatarUrl: 'https://cdn.example/ana.jpg',
      planName: 'Monthly',
      status: MembershipStatus.ACTIVE,
      endsOn: '2026-09-14',
      daysRemaining: 25,
    });
  });

  it('renders a member with no plan rather than omitting them', () => {
    const member = toDeskMember(
      { ...USER, memberCode: null, avatarUrl: null },
      null,
      verdict(null),
    );
    expect(member.planName).toBeNull();
    expect(member.status).toBeNull();
    expect(member.daysRemaining).toBeNull();
  });
});

describe('toDeskGuest', () => {
  it('splits a walk-in guest name and carries no account fields', () => {
    const guest = toDeskGuest('Nino Cruz');
    expect(guest.userId).toBeNull();
    expect(guest.firstName).toBe('Nino');
    expect(guest.lastName).toBe('Cruz');
    expect(guest.memberCode).toBeNull();
    expect(guest.planName).toBeNull();
  });

  it('falls back to a neutral label rather than rendering a blank row', () => {
    expect(toDeskGuest(null).firstName).toBe('Walk-in');
    expect(toDeskGuest('  ').firstName).toBe('Walk-in');
  });

  it('has the same field set as an account member, so no consumer branches', () => {
    expect(Object.keys(toDeskGuest('Nino Cruz')).sort()).toEqual(
      Object.keys(toDeskMember(USER, null, verdict(null))).sort(),
    );
  });
});

describe('toCheckInRecord', () => {
  it("never carries a guest's email or phone, even when the row holds them", () => {
    // Cast because CheckInRecordSource does not name these columns — which is
    // the point: a wider `select` upstream must still never leak them.
    const row = {
      id: 'c-2',
      entryType: 'WALK_IN',
      verdict: 'ALLOWED',
      method: 'MANUAL',
      occurredAt: new Date('2026-08-20T10:00:00.000Z'),
      endedAt: null,
      closeMethod: null,
      autoClosed: false,
      reopenCount: 0,
      voidedAt: null,
      voidReason: null,
      guestName: 'Ana Cruz',
      guestEmail: 'ana@example.com',
      guestPhone: '09171234567',
      paymentId: null,
      station: null,
      user: null,
    } as unknown as CheckInRecordSource;

    const serialised = JSON.stringify(toCheckInRecord(row, TODAY, CFG));
    for (const leak of ['ana@example.com', 'guestEmail', '09171234567', 'guestPhone']) {
      expect(serialised).not.toContain(leak);
    }
  });
});

describe('toActiveCheckIn', () => {
  it('rounds the duration rather than truncating it', () => {
    const member = toDeskMember(USER, snapshot(), verdict(snapshot()));
    // 14 minutes exactly.
    expect(toActiveCheckIn(checkInRow(), member, NOW).durationMinutes).toBe(14);
    // 50 seconds: a board reading "0 m" for most of a minute looks stuck.
    const fresh = checkInRow({ occurredAt: new Date(NOW.getTime() - 50_000) });
    expect(toActiveCheckIn(fresh, member, NOW).durationMinutes).toBe(1);
  });

  it('never reports a negative duration from a clock skew', () => {
    const member = toDeskMember(USER, null, verdict(null));
    const future = checkInRow({ occurredAt: new Date(NOW.getTime() + 60_000) });
    expect(toActiveCheckIn(future, member, NOW).durationMinutes).toBe(0);
  });
});

describe('toDeskArrival', () => {
  it('renders an open visit as a CHECK_IN at its start', () => {
    const arrival = toDeskArrival(checkInRow(), toDeskMember(USER, null, verdict(null)));
    expect(arrival.kind).toBe('CHECK_IN');
    expect(arrival.at).toBe('2026-08-20T10:00:00.000Z');
  });

  /**
   * Showing a departed member as an arrival is how a "who is in the building"
   * board loses the trust that makes it worth having.
   */
  it('renders a closed visit as a CHECK_OUT at the instant it closed', () => {
    const closed = checkInRow({ endedAt: new Date('2026-08-20T11:26:00.000Z') });
    const arrival = toDeskArrival(closed, toDeskMember(USER, null, verdict(null)));
    expect(arrival.kind).toBe('CHECK_OUT');
    expect(arrival.at).toBe('2026-08-20T11:26:00.000Z');
  });
});

describe('toDeskDenial', () => {
  it('carries the staff directive, not the member copy', () => {
    const expired = snapshot({ endsOn: asCivilDate('2026-07-01') });
    const staff = verdict(expired).message;
    const denial = toDeskDenial(
      {
        id: 'd-1',
        occurredAt: NOW,
        reason: 'MEMBERSHIP_EXPIRED',
        outcome: 'UNRESOLVED',
        tokenStalenessSeconds: null,
        offSiteOrigin: true,
        station: { code: '9F2K', name: 'Front desk' },
      },
      toDeskMember(USER, expired, verdict(expired)),
      staff,
    );

    expect(denial.staffMessage).toBe(staff);
    // Blunt, and never sent to a handset.
    expect(denial.staffMessage).toMatch(/Renew|walk-in/i);
    expect(denial.offSiteOrigin).toBe(true);
  });
});

describe('toDeskStationStatus', () => {
  const station = {
    id: 's-1',
    code: '9F2K',
    name: 'Front desk',
    isActive: true,
    lastTokenIssuedAt: NOW,
  };
  // 30 s slots x 10 = a 300 s batch window; `live` allows two.
  const WINDOW = 300;

  it('is live while the display is still minting', () => {
    expect(toDeskStationStatus(station, NOW, WINDOW).live).toBe(true);
  });

  /**
   * Two batch windows of slack, not one. A display that misses a single poll
   * is a flaky network, not a dark screen, and a tile that flickers DARK on
   * every dropped packet is a tile staff learns to ignore.
   */
  it('tolerates one missed batch and reports dark after two', () => {
    const oneLate = new Date(NOW.getTime() + 1.5 * WINDOW * 1000);
    const twoLate = new Date(NOW.getTime() + 2.5 * WINDOW * 1000);
    expect(toDeskStationStatus(station, oneLate, WINDOW).live).toBe(true);
    expect(toDeskStationStatus(station, twoLate, WINDOW).live).toBe(false);
  });

  it('is never live when the station has been switched off', () => {
    expect(toDeskStationStatus({ ...station, isActive: false }, NOW, WINDOW).live).toBe(false);
  });

  it('is never live when it has minted nothing at all', () => {
    expect(toDeskStationStatus({ ...station, lastTokenIssuedAt: null }, NOW, WINDOW).live).toBe(
      false,
    );
  });
});

describe('SELLABLE_DENIAL_REASONS', () => {
  /**
   * The funnel is a query, not a column. GYM_CLOSED, CHECKIN_DAILY_LIMIT and
   * STATION_TOKEN_EXPIRED would otherwise sit UNRESOLVED forever and poison
   * the conversion rate — no staffer can "resolve" a member who scanned a
   * stale code.
   */
  it('excludes every reason the desk cannot sell against', () => {
    for (const unsellable of ['GYM_CLOSED', 'CHECKIN_DAILY_LIMIT', 'STATION_TOKEN_EXPIRED']) {
      expect(SELLABLE_DENIAL_REASONS).not.toContain(unsellable);
    }
  });

  it('includes every membership reason a walk-in or renewal resolves', () => {
    expect([...SELLABLE_DENIAL_REASONS].sort()).toEqual([
      'MEMBERSHIP_CANCELLED',
      'MEMBERSHIP_EXPIRED',
      'MEMBERSHIP_FROZEN',
      'NO_MEMBERSHIP',
    ]);
  });
});

describe('cursorFrom', () => {
  it('returns the latest instant seen', () => {
    expect(
      cursorFrom(
        [new Date('2026-08-20T10:00:00.000Z'), new Date('2026-08-20T10:14:00.000Z')],
        new Date(0),
      ),
    ).toBe('2026-08-20T10:14:00.000Z');
  });

  /**
   * An empty page must NOT rewind the console's cursor to the epoch — that
   * would make the next poll fetch the whole day again, every three seconds,
   * for as long as nothing happens.
   */
  it('holds the caller cursor when the page is empty', () => {
    expect(cursorFrom([], new Date('2026-08-20T10:14:00.000Z'))).toBe('2026-08-20T10:14:00.000Z');
  });
});
