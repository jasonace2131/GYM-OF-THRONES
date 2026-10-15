import { MembershipStatus } from '@got/shared';
import { Role, UserStatus } from '@prisma/client';
import { asCivilDate } from '../common/time/gym-time';
import { toMemberListItem } from './members.presenter';

const TODAY = asCivilDate('2026-08-20');
const CFG = { expiringSoonDays: 7, graceAdmissionsMax: 3 };

type MemberRow = Parameters<typeof toMemberListItem>[0];

function membershipRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'mem-1',
    userId: 'u-1',
    planCode: 'MONTHLY',
    planName: 'Monthly',
    planPriceCentavos: 80000,
    status: MembershipStatus.ACTIVE,
    startsOn: new Date('2026-08-01T00:00:00.000Z'),
    endsOn: new Date('2026-09-14T00:00:00.000Z'),
    graceDays: 3,
    graceAdmissionsThisTerm: 0,
    cancelRequestedOn: null,
    holds: [],
    ...overrides,
  };
}

function row(membership: Record<string, unknown> | null): MemberRow {
  return {
    id: 'u-1',
    supabaseId: null,
    memberCode: '7K3M9Q',
    firstName: 'Ana',
    lastName: 'Reyes',
    email: 'ana@example.com',
    phone: '0917 555 0101',
    avatarUrl: null,
    role: Role.CLIENT,
    status: UserStatus.ACTIVE,
    emergencyContact: null,
    suspendedAt: null,
    suspendedById: null,
    suspendReason: null,
    lastSeenAt: null,
    createdAt: new Date('2026-07-02T09:00:00.000Z'),
    updatedAt: new Date('2026-07-02T09:00:00.000Z'),
    deletedAt: null,
    membership,
    _count: { checkIns: 4 },
  } as unknown as MemberRow;
}

/**
 * `cancelRequestedOn` is the ONE field the Subscriptions merge added to this
 * projection. It already rode on `MembershipSnapshot`, so it costs no extra
 * query — but a member under notice showing no notice on the merged roster
 * would be a staffer telling somebody their plan renews when it does not.
 *
 * `graceDays` was considered and declined in the same pass; see the interface
 * header for why. There is deliberately no test for it.
 */
describe('toMemberListItem — cancellation notice', () => {
  it('maps a pending cancellation through as a civil date', () => {
    const item = toMemberListItem(
      row(membershipRow({ cancelRequestedOn: new Date('2026-08-18T00:00:00.000Z') })),
      TODAY,
      CFG,
    );

    expect(item.membership?.cancelRequestedOn).toBe('2026-08-18');
  });

  it('leaves null as null for a term nobody has given notice on', () => {
    const item = toMemberListItem(row(membershipRow()), TODAY, CFG);

    expect(item.membership?.cancelRequestedOn).toBeNull();
  });

  it('still yields membership: null for a member who never bought a plan', () => {
    const item = toMemberListItem(row(null), TODAY, CFG);

    expect(item.membership).toBeNull();
  });
});
