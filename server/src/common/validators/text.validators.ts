import { applyDecorators } from '@nestjs/common';
import { Transform, type TransformFnParams } from 'class-transformer';
import { IsString, Length, Matches, MaxLength, ValidateIf } from 'class-validator';
import {
  collapseSpaces,
  normalisePhPhone,
  NAME_MAX,
  PAYMENT_REFERENCE_MAX,
  PAYMENT_REFERENCE_MIN,
  PERSON_NAME_PATTERN,
  PH_PHONE_E164,
  PH_PHONE_MESSAGE,
} from '@got/shared';

/**
 * Text-field decorators (owner, 2026-10-23). Whitespace-only text used to pass
 * a DTO and then 500 on a CHECK; these trim first, so the pipe's own Length
 * refuses it with a 400 that names the field.
 */

/** Strings are trimmed; anything else is left for the type checks to refuse. */
export const trimValue = ({ value }: TransformFnParams): unknown =>
  typeof value === 'string' ? value.trim() : value;

/** Trimmed; a blank string becomes `null` (pair with `@IsOptional`). */
export const trimOrNullValue = ({ value }: TransformFnParams): unknown => {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
};

/** `@Trim()` — trim a string before validation. */
export function Trim(): PropertyDecorator {
  return Transform(trimValue);
}

/** `@TrimOrNull()` — trim, and turn blank into `null`. */
export function TrimOrNull(): PropertyDecorator {
  return Transform(trimOrNullValue);
}

/**
 * A person's name: trimmed, inner spaces collapsed, `minLength`–60 characters,
 * letters (with accents), spaces, apostrophes, hyphens and dots — no digits.
 */
export function IsPersonName(field: string, minLength = 1): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: TransformFnParams): unknown =>
      typeof value === 'string' ? collapseSpaces(value) : value,
    ),
    IsString(),
    Length(minLength, NAME_MAX),
    Matches(PERSON_NAME_PATTERN, {
      message: `${field} may hold letters, spaces, apostrophes, hyphens and dots only`,
    }),
  );
}

/**
 * A Philippine MOBILE number, stored as `+639XXXXXXXXX`. Any accepted spelling
 * (`0917 123 4567`, `+63-917…`) is normalised before validation; anything else
 * stays as typed so the pattern check refuses it. Blank becomes `null`, so
 * with `@IsOptional` a blank clears the number.
 */
export function IsPhPhone(): PropertyDecorator {
  return applyDecorators(
    Transform(({ value }: TransformFnParams): unknown => {
      if (typeof value !== 'string') return value;
      if (value.trim() === '') return null;
      return normalisePhPhone(value) ?? value;
    }),
    IsString(),
    Matches(PH_PHONE_E164, { message: PH_PHONE_MESSAGE }),
  );
}

/**
 * A GCash / e-wallet reference (owner rule 4: loose). Any characters, trimmed,
 * 4–64 long, and at least one letter or digit — a reference of only dashes
 * normalises to nothing and would break `Payment_reference_normalized_shape`.
 *
 * `allowBlank` keeps an amend's "send blank to clear it" meaning.
 */
export function IsPaymentReference(options: { allowBlank?: boolean } = {}): PropertyDecorator {
  const checks = [
    IsString(),
    Length(PAYMENT_REFERENCE_MIN, PAYMENT_REFERENCE_MAX),
    Matches(/[A-Za-z0-9]/, { message: 'reference must contain a letter or a digit' }),
  ];
  if (!options.allowBlank) return applyDecorators(Transform(trimValue), ...checks);
  return applyDecorators(
    Transform(trimValue),
    MaxLength(PAYMENT_REFERENCE_MAX),
    ValidateIf((_obj: object, value: unknown) => value !== ''),
    ...checks,
  );
}
