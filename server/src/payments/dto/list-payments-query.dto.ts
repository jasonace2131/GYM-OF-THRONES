import { IsBoolean, IsEnum, IsOptional, IsString, IsUUID, Length } from 'class-validator';
import { Transform, type TransformFnParams } from 'class-transformer';
import { DiscountType, PaymentMethod, PaymentStatus } from '@got/shared';
import type { CivilDate } from '../../common/time/gym-time';
import { IsGymDate } from '../../common/validators/is-gym-date.validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * `from` / `to` bound `businessDate`, which is a gym-local civil date, so they
 * are IsGymDate and never IsDateString — the latter accepts a full UTC instant,
 * which is precisely how the timezone bug class gets reintroduced.
 */
export class ListPaymentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsGymDate()
  from?: CivilDate;

  @IsOptional()
  @IsGymDate()
  to?: CivilDate;

  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @IsEnum(DiscountType)
  discountType?: DiscountType;

  @IsOptional()
  @IsUUID('4')
  shiftId?: string;

  @IsOptional()
  @IsUUID('4')
  userId?: string;

  @IsOptional()
  @IsString()
  @Length(2, 32)
  planCode?: string;

  /**
   * Archived rows are a SOFT DELETE and are excluded by default;
   * `?archived=true` shows ONLY them, which is what makes the toggle a view
   * rather than a widening of the default list.
   *
   * Read off the RAW query object, matching `ListMembersQueryDto.deleted`:
   * `enableImplicitConversion` coerces the string `'false'` to `true` for a
   * `boolean`-typed field, which would make `?archived=false` mean the
   * opposite of what it says.
   */
  @Transform(({ obj }: TransformFnParams) => {
    const raw = (obj as Record<string, unknown>)['archived'];
    if (raw === undefined || raw === null || raw === '') return false;
    return raw === true || raw === 'true';
  })
  @IsBoolean()
  archived: boolean = false;
}
