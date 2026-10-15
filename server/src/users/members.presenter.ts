import type { Membership, MembershipHold, Role, User, UserStatus } from '@prisma/client';
import type { AccessDecision, AllowReason, DenialReason, MembershipStatus } from '@got/shared';
import { civilDateFromPrisma, type CivilDate } from '../common/time/gym-time';
import {
  accessVerdict,
  type AccessVerdictConfig,
  type MembershipSnapshot,
} from '../membership/access-verdict';
import { toMembershipSnapshot } from '../membership/membership.presenter';

/**
 * The CRM's member row.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY THIS EXISTS ALONGSIDE `MembershipListItem` AND `DeskMember`.
 *
 * Three projections of a person, three different questions, three different
 * audiences — and collapsing them would be a mistake in each direction:
 *
 *   - `DeskMember` answers "who just walked in" on a screen in a PUBLIC
 *     LOBBY, so it carries no contact details at all.
 *   - `MembershipListItem` answers "what is the state of this TERM", and only
 *     exists for people who have one.
 *   - `MemberListItem` (here) answers "who are our people" for a staff member
 *     at a desk, behind a counter, working a phone number. It therefore
 *     INCLUDES people with no membership — the ones a subscription list
 *     structurally cannot show, and exactly the ones a CRM exists to chase.
 *
 * `seniorPwdIdNo` is deliberately absent even here: it is a statutory
 * identifier read at the point of a discounted sale, not a browsing field, and
 * a list endpoint is the wrong place for it. `email` and `phone` ARE present —
 * this list is behind `member.read`, which CLIENT does not hold, and a CRM
 * whose member list cannot produce a phone number is not a CRM.
 * ─────────────────────────────────────────────────────────────────────────
 */
export interface MemberListItem {
  userId: string;
  memberCode: string | null;
  firstName: string;
  lastName: string;
  email: string;
  phone: string | null;
  avatarUrl: string | null;
  role: Role;
  status: UserStatus;
  joinedOn: CivilDate;
  lastSeenAt: string | null;

  /**
   * Null for every row on every ordinary read — the default filter excludes
   * soft-deleted members entirely. It is non-null only under the CRM's own
   * `?deleted=true` toggle, and it is serialized for exactly one reason: the
   * drawer opened from that view has to know it is looking at a deleted
   * member so it can offer Restore instead of Delete.
   */
  deletedAt: string | null;

  /** Free text, staff-entered via `PATCH /members/:id`. Null until set. */
  emergencyContact: string | null;

  /**
   * Null for a member who has never bought a plan.
   *
   * `graceDays` IS NOT HERE, AND THAT WAS A DECISION — considered and
   * declined when `/admin/subscriptions` merged into the member roster.
   * `MembershipListItem` carries it (membership.presenter.ts), the merged-away
   * screen was built on that projection, and NOTHING EVER RENDERED IT: it
   * crossed the wire on every row to be thrown away. Adding it here would have
   * copied that across.
   *
   * The fact a staffer actually needs is "is this member inside their grace
   * window", and that is already on the row as `decision === 'GRACE'` — the
   * same arithmetic the door performs. Same reasoning as `DeskMember`'s own
   * documented omissions: a list field earns its place by being read, not by
   * being available.
   */
  membership: {
    id: string;
    planCode: string;
    planName: string;
    status: MembershipStatus;
    startsOn: CivilDate;
    endsOn: CivilDate;
    daysRemaining: number | null;
    /**
     * The date a member gave notice, or null.
     *
     * The merged roster is the renewal CALL SHEET, and a member already under
     * notice is the one row on it nobody should ring about renewing. It costs
     * nothing to carry: `toMembershipSnapshot` reads it off the same
     * `Membership` row the rest of this object comes from.
     */
    cancelRequestedOn: CivilDate | null;
  } | null;

  /**
   * The DOOR's answer, not the stored column.
   *
   * Every list projects the stored status THROUGH `accessVerdict`, which is
   * what stops the CRM and the desk disagreeing in front of a member: a missed
   * nightly run leaves rows reading ACTIVE that the door correctly refuses,
   * and a CRM showing the stale value is how a staffer ends up telling someone
   * they are fine while the turnstile says otherwise.
   */
  decision: AccessDecision;
  allowReason: AllowReason | null;
  denialReason: DenialReason | null;

  /** Non-voided admissions, ever. The CRM's "23 check-ins" column. */
  checkInCount: number;
}

type MemberRow = User & {
  membership: (Membership & { holds: MembershipHold[] }) | null;
  _count: { checkIns: number };
};

export function toMemberListItem(
  row: MemberRow,
  today: CivilDate,
  cfg: AccessVerdictConfig,
): MemberListItem {
  const snapshot: MembershipSnapshot | null =
    row.membership === null
      ? null
      : toMembershipSnapshot(row.membership, row.membership.holds[0] ?? null);

  const verdict = accessVerdict(
    {
      userStatus: row.status,
      membership: snapshot,
      // A LIST-ONLY simplification, and it can only ever make the row read
      // more conservatively ("no valid plan" for someone who bought a day
      // pass an hour ago). Resolving it properly would cost one query per row
      // on a paginated screen, and the door — which is the only place the
      // answer changes an outcome — resolves it inside its own transaction.
      dayPassValidToday: false,
    },
    today,
    cfg,
  );

  return {
    userId: row.id,
    memberCode: row.memberCode,
    firstName: row.firstName,
    lastName: row.lastName,
    email: row.email,
    phone: row.phone,
    avatarUrl: row.avatarUrl,
    role: row.role,
    status: row.status,
    joinedOn: civilDateFromPrisma(new Date(row.createdAt.toISOString().slice(0, 10))),
    lastSeenAt: row.lastSeenAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    emergencyContact: row.emergencyContact,
    membership:
      row.membership === null || snapshot === null
        ? null
        : {
            id: row.membership.id,
            planCode: row.membership.planCode,
            planName: snapshot.planName,
            status: snapshot.status,
            startsOn: snapshot.startsOn,
            endsOn: snapshot.endsOn,
            daysRemaining: verdict.daysRemaining,
            cancelRequestedOn: snapshot.cancelRequestedOn,
          },
    decision: verdict.decision,
    allowReason: verdict.allowReason,
    denialReason: verdict.denialReason,
    checkInCount: row._count.checkIns,
  };
}
