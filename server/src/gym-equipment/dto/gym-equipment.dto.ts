import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUUID, ValidateIf } from 'class-validator';
import { Transform } from 'class-transformer';
import { GYM_EQUIPMENT_LIMITS } from '@got/shared';
import { IsCodePointLength } from '../../common/validators/is-code-point-length.validator';

/** Trimmed before validation, so the length checked is the length stored. */
const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Body of `POST /admin/equipment` and `PATCH /admin/equipment/:id`. */
export class GymEquipmentDto {
  @Transform(trim)
  @IsString()
  @IsCodePointLength(1, GYM_EQUIPMENT_LIMITS.nameMax)
  name!: string;

  /** Optional; empty or null clears it. */
  @IsOptional()
  @Transform(trim)
  @ValidateIf((_, value) => value !== null && value !== '')
  @IsString()
  @IsCodePointLength(1, GYM_EQUIPMENT_LIMITS.detailMax)
  detail?: string | null;
}

/** Body of `PUT /admin/equipment/order`: every id, in the new order. */
export class ReorderGymEquipmentDto {
  @IsArray()
  @ArrayMaxSize(500)
  @IsUUID('all', { each: true })
  ids!: string[];
}
