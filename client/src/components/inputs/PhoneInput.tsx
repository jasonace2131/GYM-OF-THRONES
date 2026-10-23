'use client';

import { useId, useState, type CSSProperties, type InputHTMLAttributes } from 'react';
import { filterPhoneTyping, isPhPhone, PH_PHONE_MESSAGE } from '@got/shared';

/**
 * A Philippine mobile number field (owner, 2026-10-23), for the portal, the
 * admin console and the public pages alike. Plain props and inline styles — no
 * Tailwind — so it can sit inside any of the three surfaces.
 *
 * Letters cannot be typed: every change goes through `filterPhoneTyping`
 * (digits, spaces, dashes, one leading `+`, cut at 16). There is deliberately
 * no `maxLength`: the browser would cut a paste like "(0917) 123-4567" BEFORE
 * the filter drops the brackets. The value handed back is what the person
 * typed; the caller sends `normalisePhPhone(value)` (`+639XXXXXXXXX`).
 * After the field is left, an invalid non-blank number shows the shared
 * message under it — unless the caller owns the error via `error`.
 */
export interface PhoneInputProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange' | 'type' | 'maxLength'> {
  value: string;
  onChange: (value: string) => void;
  /** An error the caller owns (`null` = none). When given, the built-in message is not shown. */
  error?: string | null;
  errorStyle?: CSSProperties;
}

const ERROR_STYLE: CSSProperties = {
  color: 'var(--p-danger, #b3261e)',
  fontSize: 13,
  margin: 0,
  display: 'block',
};

export function phoneProblem(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' || isPhPhone(trimmed) ? null : PH_PHONE_MESSAGE;
}

export function PhoneInput({
  value,
  onChange,
  error,
  errorStyle,
  onBlur,
  placeholder = '0917 123 4567',
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  ...rest
}: PhoneInputProps) {
  const [left, setLeft] = useState(false);
  const autoId = useId();
  const errorId = `${rest.id ?? autoId}-phone-error`;
  const owned = error !== undefined;
  const problem = owned ? error : left ? phoneProblem(value) : null;
  // Only an error this component renders gets its id referenced.
  const rendersError = !owned && problem !== null;
  const describedByIds =
    [describedBy, rendersError ? errorId : undefined].filter(Boolean).join(' ') || undefined;

  return (
    <>
      <input
        {...rest}
        type="tel"
        inputMode="tel"
        autoComplete={rest.autoComplete ?? 'tel'}
        placeholder={placeholder}
        value={value}
        onChange={(event) => onChange(filterPhoneTyping(event.target.value))}
        onBlur={(event) => {
          setLeft(true);
          onBlur?.(event);
        }}
        aria-invalid={problem ? true : ariaInvalid}
        aria-describedby={describedByIds}
      />
      {rendersError ? (
        <span id={errorId} role="alert" style={{ ...ERROR_STYLE, ...errorStyle }}>
          {problem}
        </span>
      ) : null}
    </>
  );
}
