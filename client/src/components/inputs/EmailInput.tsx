'use client';

import type { InputHTMLAttributes } from 'react';
import { EMAIL_MAX } from '@got/shared';
import { EMAIL_INPUT_PROPS } from '@/lib/credentials';

/**
 * An email field: the phone-keyboard guards (`EMAIL_INPUT_PROPS`), capped at
 * 254 characters, and trimmed when the field is left.
 */
export interface EmailInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'maxLength'> {
  value: string;
  onChange: (value: string) => void;
}

export function EmailInput({ value, onChange, onBlur, ...rest }: EmailInputProps) {
  return (
    <input
      autoComplete="email"
      {...EMAIL_INPUT_PROPS}
      {...rest}
      type="email"
      maxLength={EMAIL_MAX}
      value={value}
      onChange={(event) => onChange(event.target.value)}
      onBlur={(event) => {
        const trimmed = value.trim();
        if (trimmed !== value) onChange(trimmed);
        onBlur?.(event);
      }}
    />
  );
}
