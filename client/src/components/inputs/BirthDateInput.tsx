'use client';

import type { InputHTMLAttributes } from 'react';
import { MINIMUM_AGE_MESSAGE, earliestBirthDateFor, latestBirthDateFor } from '@got/shared';

/**
 * A date-of-birth field (owner, 2026-10-30: nobody under 12 has an account),
 * for sign-up, the setup link and the counter alike. Plain props, no Tailwind,
 * so it sits inside any of the three surfaces.
 *
 * The picker offers only dates the API accepts: `min` is the 120-year bound,
 * `max` the latest birthday that is 12 on `today` (`yyyy-mm-dd`, the caller's).
 * A browser checks `max` itself before a form's own submit runs, and would say
 * "Value must be … or earlier"; this puts the minimum-age sentence in that
 * bubble instead, so the person reads why. The caller still checks on submit.
 */
export interface BirthDateInputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  'value' | 'onChange' | 'type' | 'min' | 'max'
> {
  value: string;
  onChange: (value: string) => void;
  today: string;
}

export function BirthDateInput({
  value,
  onChange,
  today,
  onInvalid,
  ...rest
}: BirthDateInputProps) {
  return (
    <input
      {...rest}
      type="date"
      min={earliestBirthDateFor(today)}
      max={latestBirthDateFor(today)}
      value={value}
      onChange={(event) => {
        // A message set below would otherwise keep the field invalid for good.
        event.currentTarget.setCustomValidity('');
        onChange(event.target.value);
      }}
      onInvalid={(event) => {
        if (event.currentTarget.validity.rangeOverflow) {
          event.currentTarget.setCustomValidity(MINIMUM_AGE_MESSAGE);
        }
        onInvalid?.(event);
      }}
    />
  );
}
