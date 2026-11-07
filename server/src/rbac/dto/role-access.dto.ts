import { Transform, Type, type TransformFnParams } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  Length,
  Matches,
  ValidateNested,
} from 'class-validator';
import { ROLE_ACCESS_REASON_MAX, ROLE_ACCESS_REASON_MIN } from '@got/shared';

const trimmed = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Every role in the URL; DEV is refused by the service with a reason, not a 400. */
export const ROLE_PARAM_VALUES = ['CLIENT', 'FRONT_DESK', 'COACH', 'ADMIN', 'DEV'] as const;

export class RoleParamDto {
  @IsIn(ROLE_PARAM_VALUES)
  role!: (typeof ROLE_PARAM_VALUES)[number];
}

export class RoleGrantDto {
  /** `resource.action` or `resource.sub.action`, as the catalogue spells them. */
  @IsString()
  @Matches(/^[a-z_]+(\.[a-z_]+){1,3}$/)
  key!: string;

  @IsIn(['OWN', 'ALL'])
  scope!: 'OWN' | 'ALL';
}

/**
 * `PUT /admin/roles/:role/permissions` — the WHOLE set the role should hold.
 * A full set rather than a patch, so the screen and the table cannot half-agree.
 */
export class SaveRoleAccessDto {
  @IsArray()
  @ArrayMaxSize(300)
  @ArrayUnique((grant: RoleGrantDto) => grant.key)
  @ValidateNested({ each: true })
  @Type(() => RoleGrantDto)
  grants!: RoleGrantDto[];

  /** Kept in Audit Logs with the change. */
  @Transform(trimmed)
  @IsString()
  @Length(ROLE_ACCESS_REASON_MIN, ROLE_ACCESS_REASON_MAX)
  reason!: string;

  /** Required when the save grants a dangerous permission. */
  @IsOptional()
  @IsBoolean()
  confirm?: boolean;
}

/** `POST /admin/roles/:role/permissions/reset`. */
export class ResetRoleAccessDto {
  @Transform(trimmed)
  @IsString()
  @Length(ROLE_ACCESS_REASON_MIN, ROLE_ACCESS_REASON_MAX)
  reason!: string;
}
