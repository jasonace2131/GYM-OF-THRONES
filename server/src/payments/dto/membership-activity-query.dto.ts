import { ReportRangeQueryDto } from './report-range-query.dto';

/**
 * `GET /reports/memberships` — membership MOVEMENT in a window.
 *
 * Nothing but the range, and that is the point: this report reads
 * `MembershipEvent`, which is append-only and carries `effectiveAt`, so a
 * from/to over it answers a historical question honestly.
 *
 * The obvious alternative — adding `from`/`to` to `ListMembershipsQueryDto` —
 * would not. `Membership.userId` is `@unique`: exactly one row per member for
 * the life of the account, with renewals MUTATING that row. So `startsOn` and
 * `endsOn` describe only the CURRENT term, and a date filter over them would
 * answer "who was a member in March" with "whoever's current term happens to
 * straddle March", while looking entirely correct.
 */
export class MembershipActivityQueryDto extends ReportRangeQueryDto {}
