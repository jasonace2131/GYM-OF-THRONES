import { Role } from '@prisma/client';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length } from 'class-validator';

/**
 * `POST /members/:id/role`. Every role EXCEPT `DEV` — built from the real
 * imported enum, never hand-copied strings, so a fifth role added to
 * `Role` is either included here deliberately or the list below is the one
 * place that needs revisiting, not a second enum drifting out of sync.
 *
 * `DEV` is "assignable only by seed or direct DB access" (schema.prisma's own
 * comment on the enum) — granting it through an HTTP route would contradict
 * that on day one.
 */
export const ASSIGNABLE_ROLES = [Role.CLIENT, Role.FRONT_DESK, Role.COACH, Role.ADMIN] as const;

const trimmed = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class ChangeRoleDto {
  @IsIn(ASSIGNABLE_ROLES)
  role!: (typeof ASSIGNABLE_ROLES)[number];

  /**
   * Why the role moved. `role.change` is on the dangerous-action list, and
   * the console's confirmation asks for a reason before it sends one; the
   * audit entry then carries it beside the before/after pair.
   *
   * OPTIONAL on the wire, deliberately: requiring it here would break every
   * caller that predates the confirmation, and a reason is only as good as
   * the screen that asks for it. The same 3–200 bound as every other reason
   * in the API, counted after trimming.
   */
  @IsOptional()
  @Transform(trimmed)
  @IsString()
  @Length(3, 200)
  reason?: string;
}
