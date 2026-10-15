import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';
import { PAGINATION_DEFAULTS } from '@got/shared';

/**
 * The four consequences of this codebase's global ValidationPipe, written down
 * once, here, because this is the first DTO anyone reads. Every DTO author in
 * this repository needs them, in the order they bite.
 *
 * The pipe runs with `whitelist: true`, `forbidNonWhitelisted: true`,
 * `transform: true` and `enableImplicitConversion: true`. Therefore:
 *
 * 1. EVERY endpoint with a body or a typed query needs a DTO. Unknown
 *    properties are not stripped, they are rejected outright — which is why a
 *    list DTO that forgets to extend this class 400s on `?page=2`.
 * 2. `strict` TypeScript means every REQUIRED property takes the
 *    definite-assignment `!`. Optional ones take `?` and no `!`.
 * 3. Implicit conversion coerces by the reflected design type BEFORE the
 *    validators run, so `{"netCentavos": "8000"}` passes `@IsInt()`. Input is
 *    lenient and storage is strict, which is acceptable — but `@IsInt()` alone
 *    is never proof the client sent a number, so money always pairs with
 *    `@Min`/`@Max`.
 * 4. Nested objects need `@Type(() => Dto)` AND `@ValidateNested()`. With only
 *    one of them, `whitelist` strips the object to `{}` and validation passes
 *    silently.
 *
 * Pagination is offset-based and reuses `PaginatedData<T>` and
 * `PAGINATION_DEFAULTS` from `@got/shared`. One gym, tens of thousands of
 * check-ins at most; a second pagination contract would buy nothing.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = PAGINATION_DEFAULTS.PAGE;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(PAGINATION_DEFAULTS.MAX_LIMIT)
  limit: number = PAGINATION_DEFAULTS.LIMIT;
}
