import { PlanKind } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListPlansQueryDto extends PaginationQueryDto {
  /**
   * Read off the RAW query object, not off the implicitly converted value:
   * `enableImplicitConversion` coerces by the reflected design type, and for a
   * `boolean` that turns the string 'false' into `true`. `?includeInactive=false`
   * would otherwise mean the opposite of what it says. class-transformer applies
   * custom @Transform functions LAST, with `obj` still holding the untouched
   * query string, which is why this reads `obj`.
   */
  @Transform(({ obj }) => {
    const raw = (obj as Record<string, unknown>)['includeInactive'];
    if (raw === undefined || raw === null || raw === '') return false;
    return raw === true || raw === 'true';
  })
  @IsBoolean()
  includeInactive: boolean = false;

  @IsOptional()
  @IsEnum(PlanKind)
  kind?: PlanKind;
}
