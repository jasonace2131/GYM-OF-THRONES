import { applyDecorators } from '@nestjs/common';
import { Type } from 'class-transformer';
import { IsInt, Max, Min } from 'class-validator';
import type { ValidationOptions } from 'class-validator';

/**
 * Money, as an integer number of centavos.
 *
 * The bounds are written to match the money CHECK constraint on the column the
 * field lands in, so there is no input the pipe accepts that the database then
 * rejects — a 422 from a CHECK is a bug report, never a user-facing path.
 *
 * No Decimal, no BigInt (Prisma maps it to JS BigInt, which JSON.stringify
 * throws on, and every response passes through TransformInterceptor), no
 * floats. int4 caps at ₱21,474,836.47 per row against a largest published
 * price of ₱7,500.
 *
 * Note that enableImplicitConversion coerces by the reflected design type
 * BEFORE validators run, so `{"grossCentavos": "80000"}` passes @IsInt().
 * Input is lenient and storage is strict; that is why the Min/Max pair is not
 * optional here.
 */
export function IsCentavos(
  min: number,
  max: number,
  options?: ValidationOptions,
): PropertyDecorator {
  return applyDecorators(
    Type(() => Number),
    IsInt({ message: '$property must be a whole number of centavos', ...options }),
    Min(min, options),
    Max(max, options),
  );
}
