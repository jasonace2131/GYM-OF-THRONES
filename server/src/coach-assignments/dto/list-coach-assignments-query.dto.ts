import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsUUID } from 'class-validator';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

export class ListCoachAssignmentsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID('4')
  coachId?: string;

  @IsOptional()
  @IsUUID('4')
  memberId?: string;

  /**
   * Read off the RAW query object, not off the implicitly converted value.
   *
   * `enableImplicitConversion` coerces by the reflected design type, and for a
   * `boolean` property that turns the string 'false' into `true` — so
   * `?activeOnly=false` would silently mean the opposite of what it says.
   * class-transformer applies custom @Transform functions LAST, with `obj`
   * still holding the untouched query string, which is why this reads `obj`.
   */
  @Transform(({ obj }) => {
    const raw = (obj as Record<string, unknown>)['activeOnly'];
    if (raw === undefined || raw === null || raw === '') return true;
    return raw === true || raw === 'true';
  })
  @IsBoolean()
  activeOnly: boolean = true;
}
