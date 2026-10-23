'use client';

import type { InputHTMLAttributes } from 'react';
import { collapseSpaces, filterNameTyping, NAME_MAX } from '@got/shared';

/**
 * A person's name field (owner, 2026-10-23): letters with accents, spaces,
 * apostrophes, hyphens and dots — digits and symbols cannot be typed. Capped at
 * `NAME_MAX`; trimmed with inner spaces collapsed when the field is left.
 */
export interface NameInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'maxLength'> {
  value: string;
  onChange: (value: string) => void;
}

export function NameInput({ value, onChange, onBlur, ...rest }: NameInputProps) {
  return (
    <input
      autoCapitalize="words"
      spellCheck={false}
      {...rest}
      type="text"
      maxLength={NAME_MAX}
      value={value}
      onChange={(event) => onChange(filterNameTyping(event.target.value))}
      onBlur={(event) => {
        const tidy = collapseSpaces(value);
        if (tidy !== value) onChange(tidy);
        onBlur?.(event);
      }}
    />
  );
}
