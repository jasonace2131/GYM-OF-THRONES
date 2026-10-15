import { IsBoolean, IsEnum, IsIn, IsOptional, IsString, Length } from 'class-validator';
import { Role } from '@prisma/client';
import { Transform, type TransformFnParams } from 'class-transformer';
import { MembershipStatus } from '@got/shared';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/** The CRM's own filter vocabulary, which is deliberately not the stored one. */
export const MEMBER_STANDINGS = ['ACTIVE', 'EXPIRING', 'EXPIRED', 'NONE'] as const;
export type MemberStanding = (typeof MEMBER_STANDINGS)[number];

/**
 * Two orders, and the second one is a business artefact.
 *
 * `ending` is the RENEWAL CALL SHEET — the order the Subscriptions screen
 * was read in before it merged into this list, and the whole reason that
 * screen existed. Losing it would have been the real cost of the merge, so
 * it is a first-class, validated parameter rather than a client-side sort
 * over one page of fifteen rows.
 */
export const MEMBER_SORTS = ['recent', 'ending'] as const;
export type MemberSort = (typeof MEMBER_SORTS)[number];

export class ListMembersQueryDto extends PaginationQueryDto {
  /**
   * Name, member code, email or phone.
   *
   * Phone is searchable because it is how a member identifies themselves on
   * the telephone — which is the single most common way this list actually
   * gets used: somebody rings to ask when their plan ends.
   */
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsOptional()
  @IsString()
  @Length(1, 64)
  search?: string;

  @IsOptional()
  @IsString()
  @Length(2, 32)
  planCode?: string;

  /**
   * Staff, not members.
   *
   * The same roster endpoint answers "who are our coaches" because a coach IS
   * a user with a role — there is no separate Coach table, and inventing one
   * would be a second place to keep a name and a phone number in sync.
   */
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  /**
   * Staff & Access: everybody who is NOT a member (role ≠ CLIENT) — front
   * desk, coaches, admins and the Super Admin, in one list. An explicit `role`
   * above wins, so the staff screen's role filter narrows within staff.
   *
   * Read off the RAW query for the same reason as `deleted` below:
   * implicit conversion turns the string `'false'` into `true`.
   */
  @Transform(({ obj }: TransformFnParams) => {
    const raw = (obj as Record<string, unknown>)['staff'];
    if (raw === undefined || raw === null || raw === '') return undefined;
    return raw === true || raw === 'true';
  })
  @IsOptional()
  @IsBoolean()
  staff?: boolean;

  /** The STORED status, for when a staffer wants exactly that. */
  @IsOptional()
  @IsEnum(MembershipStatus)
  membershipStatus?: MembershipStatus;

  /**
   * THE CRM's FILTER, and deliberately NOT `MembershipStatus`.
   *
   * "Expiring" is not a stored value and must never become one — it is
   * `endsOn` inside the configured window, computed from columns already on
   * the row. A stored EXPIRING status would be a second source of truth that a
   * missed nightly run silently falsifies, which is the whole reason
   * `MembershipStatus` has exactly four values.
   *
   * `NONE` is the one the mockup's dropdown does not have and the business
   * most needs: people with an account and no plan are exactly the list a gym
   * rings.
   */
  @IsOptional()
  @IsIn(MEMBER_STANDINGS)
  standing?: MemberStanding;

  /**
   * Declared rather than inferred: `forbidNonWhitelisted` rejects any query
   * property without a DTO field, so an un-declared `?sort=ending` is a 400
   * rather than an ignored parameter.
   *
   * `@IsIn` over a const tuple, matching `standing` above — an `@IsEnum`
   * would need a TS enum nobody else wants, and a bare `@IsString()` would
   * let `?sort=; DROP` through to a switch that silently falls back.
   */
  @IsOptional()
  @IsIn(MEMBER_SORTS)
  sort: MemberSort = 'recent';

  /**
   * Excluded by default (§4.4 — soft-deleted members are invisible to every
   * read unless this one, explicit, admin-facing toggle asks otherwise).
   *
   * Read off the RAW query object, matching `ListPlansQueryDto.includeInactive`:
   * `enableImplicitConversion` coerces the string `'false'` to `true` for a
   * `boolean`-typed field, which would make `?deleted=false` mean the
   * opposite of what it says.
   */
  @Transform(({ obj }: TransformFnParams) => {
    const raw = (obj as Record<string, unknown>)['deleted'];
    if (raw === undefined || raw === null || raw === '') return false;
    return raw === true || raw === 'true';
  })
  @IsBoolean()
  deleted: boolean = false;
}
