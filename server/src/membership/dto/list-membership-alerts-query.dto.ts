import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * `GET /memberships/alerts` — the Notifications panel's expiry alerts, one
 * page at a time (owner, 2026-10-08: never fetch the whole list).
 */
export class ListMembershipAlertsQueryDto extends PaginationQueryDto {
  /** Matched against the MEMBER — name, member code, email — like `GET /memberships`. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  search?: string;

  /** Only the alerts staff archived for the current term. */
  @Transform(({ obj }) => {
    const raw = (obj as Record<string, unknown>)['archived'];
    return raw === true || raw === 'true';
  })
  @IsOptional()
  @IsBoolean()
  archived: boolean = false;
}
