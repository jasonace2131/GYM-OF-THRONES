import { IsBoolean, IsOptional, IsString, Length } from 'class-validator';
import { Transform, type TransformFnParams } from 'class-transformer';

/**
 * `GET /members/counts` — the roster's KPI tiles.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * DELIBERATELY NOT `ListMembersQueryDto`, AND DELIBERATELY NOT PAGINATED.
 *
 * It does NOT extend `PaginationQueryDto`: there is no page of anything to
 * return, and inheriting `page`/`limit` would make `?page=3` a silently
 * accepted no-op — a parameter that looks like it works and does nothing.
 *
 * It carries no `standing` either, and that omission is the endpoint's whole
 * point: the response counts every standing at once, so a standing filter
 * here would mean "how many active members are active", and would let the
 * tiles narrow independently of the table under them.
 *
 * What it DOES carry is exactly what the table's other filters are —
 * `search`, `planCode`, `deleted` — because the tiles must move with the
 * search box or they are describing a different population than the rows
 * beneath them.
 * ─────────────────────────────────────────────────────────────────────────
 */
export class MemberCountsQueryDto {
  /** Name, member code, email or phone — the same four handles the list
   *  searches, through the same `searchClauses` builder. */
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
   * Read off the RAW query object, verbatim from `ListMembersQueryDto`:
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
