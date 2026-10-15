import { ValidateBy } from 'class-validator';
import type { ValidationOptions } from 'class-validator';

/**
 * A string of `min`–`max` Unicode code points — what Postgres `char_length`
 * counts, and what `Array.from(text).length` counts on the client.
 *
 * Deliberately NOT `@Length`: validator.js `isLength` also drops variation
 * selectors (U+FE0E/U+FE0F), so "❤️" is one there and two in Postgres. A
 * field bounded by a CHECK would then pass the pipe and fail the CHECK as a
 * 500 instead of a 400.
 */
export const IsCodePointLength = (
  min: number,
  max: number,
  options?: ValidationOptions,
): PropertyDecorator =>
  ValidateBy(
    {
      name: 'isCodePointLength',
      constraints: [min, max],
      validator: {
        validate: (value: unknown): boolean => {
          if (typeof value !== 'string') return false;
          const length = Array.from(value).length;
          return length >= min && length <= max;
        },
        defaultMessage: (args) => `${args?.property ?? 'value'} must be ${min}–${max} characters`,
      },
    },
    options,
  );
