'use client';

import type { ComponentProps, ReactNode } from 'react';
import { cn } from '@/lib/utils';

/**
 * The planner's atoms — the mockups' cards, kickers, chips and buttons as
 * Tailwind utilities on the portal's tokens. One place, so every screen's
 * gold button is the same gold button.
 */

export function Panel({ className, ...props }: ComponentProps<'section'>) {
  return (
    <section
      className={cn(
        'rounded-[14px] border border-border bg-card shadow-[var(--p-shadow)]',
        className,
      )}
      {...props}
    />
  );
}

/** "TODAY · WEDNESDAY, SEP 30" — 11.5px, 700, wide tracking, ink-3. */
export function Kicker({ className, ...props }: ComponentProps<'span'>) {
  return (
    <span
      className={cn('text-[11.5px] font-bold tracking-[0.14em] text-ink-3 uppercase', className)}
      {...props}
    />
  );
}

/** A section title in kicker form (the mockups' h2s inside cards). */
export function KickerHeading({ className, ...props }: ComponentProps<'h2'>) {
  return (
    <h2
      className={cn(
        'm-0 text-[11.5px] font-bold tracking-[0.14em] text-ink-3 uppercase',
        className,
      )}
      {...props}
    />
  );
}

export type ChipTone = 'neutral' | 'warn' | 'info' | 'ok';

const CHIP_TONE: Record<ChipTone, string> = {
  neutral: 'bg-paper-3 text-[color:var(--p-ink)]',
  warn: 'bg-warn-bg text-warn',
  info: 'bg-info-bg text-info',
  ok: 'bg-ok-bg text-ok',
};

/** A 28px read-only pill. */
export function Chip({
  tone = 'neutral',
  className,
  ...props
}: ComponentProps<'span'> & { tone?: ChipTone }) {
  return (
    <span
      className={cn(
        'inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[12.5px] font-semibold',
        CHIP_TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

/** Badge: "ACTIVE", "DRAFT · NOT SAVED", "SWAPPED". */
export function Tag({
  tone = 'ok',
  className,
  ...props
}: ComponentProps<'span'> & { tone?: ChipTone }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2.5 py-1 text-[11px] font-bold tracking-[0.1em] uppercase',
        CHIP_TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

export type ButtonVariant = 'gold' | 'ghost' | 'dark' | 'muted';
export type ButtonSize = 'md' | 'sm' | 'xs';

const BTN_BASE =
  'inline-flex items-center justify-center gap-2 rounded-[10px] font-display font-bold tracking-[0.08em] uppercase whitespace-nowrap no-underline pointer-coarse:min-h-11 transition-[background-color,border-color,box-shadow,transform] duration-150 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100';

const BTN_VARIANT: Record<ButtonVariant, string> = {
  // The primary action. Named `gold` for history; Style A (owner,
  // 2026-10-23) made it flat ink with light text — see portal.css tokens.
  gold: 'bg-primary text-primary-foreground hover:bg-[var(--p-primary-hover)]',
  ghost:
    'border-[1.5px] border-[color:var(--p-border-2)] bg-card text-foreground hover:border-gold',
  dark: 'bg-night text-gold-lit hover:bg-black',
  muted: 'bg-paper-3 text-ink-3',
};

const BTN_SIZE: Record<ButtonSize, string> = {
  md: 'h-[46px] px-[22px] text-[14px]',
  sm: 'h-11 px-4 text-[13px]',
  xs: 'h-9 px-3.5 text-[12.5px] tracking-[0.06em]',
};

export function buttonClass(
  variant: ButtonVariant,
  size: ButtonSize = 'md',
  className?: string,
): string {
  return cn(BTN_BASE, BTN_VARIANT[variant], BTN_SIZE[size], className);
}

export function Button({
  variant = 'ghost',
  size = 'md',
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'> & { variant?: ButtonVariant; size?: ButtonSize }) {
  return <button type={type} className={buttonClass(variant, size, className)} {...props} />;
}

/** A plain (non-uppercase) 36-44px control: "Set active", "Keep", "Cancel". */
export function PlainButton({
  tone = 'ghost',
  className,
  type = 'button',
  ...props
}: ComponentProps<'button'> & { tone?: 'ghost' | 'dark' | 'ok' | 'okGhost' | 'link' }) {
  const TONE = {
    ghost:
      'h-10 rounded-lg border-[1.5px] border-[color:var(--p-border-2)] bg-card px-3.5 text-[13px] font-semibold text-foreground hover:border-gold',
    dark: 'h-10 rounded-lg bg-night px-4 text-[13px] font-semibold text-gold-lit hover:bg-black',
    ok: 'h-9 rounded-lg bg-ok px-3.5 text-[13px] font-semibold text-white',
    okGhost:
      'h-9 rounded-lg border-[1.5px] border-[rgba(26,77,46,0.35)] bg-transparent px-3.5 text-[13px] font-semibold text-ok',
    link: 'h-auto bg-transparent p-0 text-[12.5px] font-semibold text-gold-deep underline',
  } as const;
  // 44px on a touch screen for every tone but the inline text link.
  const touch = tone === 'link' ? '' : 'pointer-coarse:min-h-11';
  return (
    <button
      type={type}
      className={cn(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold disabled:cursor-not-allowed disabled:opacity-60',
        TONE[tone],
        touch,
        className,
      )}
      {...props}
    />
  );
}

/** `aria-pressed` pill: day chips, "Go easy on", adjust presets. */
export function ToggleChip({
  pressed,
  className,
  children,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-pressed'> & { pressed: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      className={cn(
        'inline-flex h-11 min-w-11 cursor-pointer items-center justify-center rounded-full border-[1.5px] px-4 text-[13.5px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold',
        pressed
          ? 'border-night bg-night text-gold-lit'
          : 'border-[color:var(--p-border-2)] bg-card text-foreground hover:border-gold',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** A `role="radio"` pill in a group: session length, time of day. */
export function RadioPill({
  checked,
  className,
  children,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-checked' | 'role'> & { checked: boolean }) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={cn(
        'inline-flex h-11 cursor-pointer items-center justify-center rounded-[10px] border-[1.5px] px-[18px] text-[14px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold',
        checked
          ? 'border-night bg-night text-gold-lit'
          : 'border-[color:var(--p-border-2)] bg-card text-foreground hover:border-gold',
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

/** A `role="radio"` card: goals and levels. */
export function RadioCard({
  checked,
  title,
  sub,
  className,
  ...props
}: Omit<ComponentProps<'button'>, 'aria-checked' | 'role' | 'title'> & {
  checked: boolean;
  title: string;
  sub: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      className={cn(
        'flex min-h-24 min-w-0 cursor-pointer flex-col items-start gap-1.5 rounded-xl border-2 p-3 text-left transition-[border-color,box-shadow] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold',
        checked
          ? 'border-gold bg-[#fffaf0] shadow-[0_0_0_3px_rgba(201,146,42,0.15)]'
          : 'border-[#e4e1dc] bg-card hover:border-[color:var(--p-border-2)]',
        className,
      )}
      {...props}
    >
      <span className="font-display text-[17px] font-bold text-foreground">{title}</span>
      <span className="text-[13px] leading-[1.4] text-ink-2">{sub}</span>
    </button>
  );
}

/** A `role="switch"` toggle, 46×28, green when on. */
export function Switch({
  checked,
  label,
  onChange,
  className,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={cn(
        // The ::after widens the hit area to 44px tall without changing the look.
        "relative h-7 w-[46px] shrink-0 cursor-pointer rounded-full border-0 p-0 transition-colors after:absolute after:-inset-x-1 after:-inset-y-2 after:content-[''] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold",
        checked ? 'bg-ok' : 'bg-[#bdb8b0]',
        className,
      )}
    >
      <span
        aria-hidden
        className={cn(
          'absolute top-[3px] h-[22px] w-[22px] rounded-full bg-white shadow-[0_1px_3px_rgba(0,0,0,0.25)] transition-[left] duration-150 motion-reduce:transition-none',
          checked ? 'left-[21px]' : 'left-[3px]',
        )}
      />
    </button>
  );
}

/** The No / Yes segmented radio group of the health check. */
export function YesNo({
  value,
  labelledBy,
  onChange,
  className,
}: {
  value: boolean;
  labelledBy: string;
  onChange: (next: boolean) => void;
  className?: string;
}) {
  const seg =
    'h-9 min-w-[52px] pointer-coarse:h-11 cursor-pointer rounded-[7px] border-0 px-3 text-[13px] font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-gold';
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      className={cn('flex gap-1 rounded-[9px] bg-paper-3 p-[3px]', className)}
    >
      <button
        type="button"
        role="radio"
        aria-checked={!value}
        onClick={() => onChange(false)}
        className={cn(
          seg,
          value
            ? 'bg-transparent text-ink-2'
            : 'bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,0.12)]',
        )}
      >
        No
      </button>
      <button
        type="button"
        role="radio"
        aria-checked={value}
        onClick={() => onChange(true)}
        className={cn(seg, value ? 'bg-warn text-white' : 'bg-transparent text-ink-2')}
      >
        Yes
      </button>
    </div>
  );
}

/** A grey skeleton bar that reserves its space; still under reduced motion. */
export function Bone({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        'block rounded-md bg-[linear-gradient(90deg,#ece9e4_0%,#f6f5f2_50%,#ece9e4_100%)] bg-[length:200%_100%] motion-safe:animate-[pShimmer_1.4s_linear_infinite]',
        className,
      )}
    />
  );
}

/** A notice strip: warn (gentle plan, 429), info (booked class), ok (adjusted). */
export function Notice({
  tone,
  icon,
  className,
  children,
  ...props
}: ComponentProps<'div'> & { tone: 'warn' | 'info' | 'ok' | 'danger'; icon?: ReactNode }) {
  const TONE = {
    warn: 'border border-[#efd9a8] bg-warn-bg text-[#5c3f0f]',
    info: 'bg-info-bg text-info',
    ok: 'bg-ok-bg text-[#1a4d2e]',
    danger: 'bg-danger-bg text-danger',
  } as const;
  return (
    <div
      className={cn(
        'flex items-start gap-3 rounded-xl px-4 py-3.5 text-[13.5px] leading-[1.5]',
        TONE[tone],
        className,
      )}
      {...props}
    >
      {icon === undefined ? null : <span className="mt-px shrink-0">{icon}</span>}
      <span className="min-w-0">{children}</span>
    </div>
  );
}
