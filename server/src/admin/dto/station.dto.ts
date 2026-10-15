import { Transform, type TransformFnParams } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';

/**
 * Route 57 — `PATCH /admin/stations/:id`.
 *
 * Every field is optional and each one is a different operational lever, which
 * is why they are not collapsed into a single "update" shape:
 *
 *   - `isActive: false` is THE OFF SWITCH. It is what "the tablet was stolen"
 *     and "that entrance is closed for renovation" both mean, and it takes
 *     effect on the next scan without a redeploy or a secret rotation.
 *   - `bumpTokenEpoch` is the PER-STATION PANIC BUTTON. It invalidates every
 *     outstanding token for THIS station within one slot — the display's
 *     head check is what makes "one slot" true rather than "one batch" — with
 *     no effect on any other station and no global secret rotation.
 *
 * `code` is deliberately absent and must stay absent: it is CSPRNG-allocated
 * once and physically printed on a label under the screen. Letting an admin
 * edit it would invalidate that label without anyone touching the tablet.
 */
export class UpdateStationDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * A one-way lever: it only ever increments, and by exactly one. A settable
   * epoch would let a typo move it BACKWARDS, which silently re-validates
   * every token minted under the old value — the precise opposite of what the
   * caller reached for it to do.
   */
  @IsOptional()
  @IsBoolean()
  bumpTokenEpoch?: boolean;
}

/** Provisioning a tablet. The secret is generated server-side, never supplied. */
export class CreateStationCredentialDto {
  /**
   * What the sticker on the back of the tablet says. Staff revoking a
   * credential six months from now are choosing between rows in a list, and
   * "Front desk tablet" versus "spare" is the whole of what makes that choice
   * possible.
   */
  @Transform(({ value }: TransformFnParams): unknown =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @Length(2, 60)
  label!: string;
}
