import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { MembershipStatus } from '@got/shared';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListMembershipsQueryDto extends PaginationQueryDto {
  /** The STORED status. The projected verdict is on every row regardless. */
  @IsOptional()
  @IsEnum(MembershipStatus)
  status?: MembershipStatus;

  /** The renewal call list: endsOn between today and today + n, inclusive. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(90)
  expiringWithinDays?: number;

  @IsOptional()
  @IsString()
  @Length(2, 32)
  planCode?: string;

  /** Matched against the MEMBER — name, member code, email — not the row. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  search?: string;
}
