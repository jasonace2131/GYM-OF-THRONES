import { registerDecorator } from 'class-validator';
import type { ValidationArguments, ValidationOptions } from 'class-validator';

/**
 * Exactly one of `fields` must be present and non-empty.
 *
 * Used by walk-in (member vs guest) and manual check-in (member id vs member
 * code) — both are genuine exclusive-ors where accepting both silently picks
 * one and records the wrong person.
 *
 * The constraint is deliberately registered against a SYNTHETIC property —
 * `exactlyOne:<fields>` — rather than `fields[0]`. class-validator groups all
 * decorators by literal property name, and `@IsOptional()` on that field (it
 * has to be optional; that is the whole point) attaches a conditional-skip
 * for the WHOLE group when the field is absent. Register on `fields[0]`
 * instead and 'rejects neither present' silently passes zero errors, because
 * `memberId` being undefined skips every validator grouped under `memberId`,
 * this one included. A synthetic property name keeps this validator its own
 * group so it always runs. `undefined`, `null` and `''` all count as absent,
 * because a form that submits an untouched input sends `''`.
 */
export function ExactlyOne(fields: string[], options?: ValidationOptions): ClassDecorator {
  if (fields.length < 2) {
    throw new Error('ExactlyOne needs at least two fields to choose between');
  }

  return (target): void => {
    registerDecorator({
      name: 'exactlyOne',
      target,
      propertyName: `exactlyOne:${fields.join(',')}`,
      constraints: [fields],
      options: {
        message: `exactly one of ${fields.join(', ')} must be provided`,
        ...options,
      },
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const object = args.object as Record<string, unknown>;
          const present = fields.filter((field) => {
            const value = object[field];
            return value !== undefined && value !== null && value !== '';
          });
          return present.length === 1;
        },
      },
    });
  };
}
