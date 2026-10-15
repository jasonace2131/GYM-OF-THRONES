import { formatGymTime, GYM_TIMEZONE } from './gymTime';
import type { AssistantSettingsView } from './adminApi';

/**
 * Characters as the server counts them: code points, so an emoji is one —
 * the count class-validator's `@Length` and Postgres `char_length` use. A
 * plain `.length` would count it as two and block a valid save early.
 */
export function characterCount(text: string): number {
  return Array.from(text).length;
}

export interface InstructionsCheck {
  /** Characters after trimming — what the server will store. */
  length: number;
  blank: boolean;
  tooLong: boolean;
  /** Differs from what is saved, ignoring whitespace at the ends (the server trims). */
  dirty: boolean;
  canSave: boolean;
}

export function checkInstructions(
  draft: string,
  saved: string,
  maxLength: number,
): InstructionsCheck {
  const trimmed = draft.trim();
  const length = characterCount(trimmed);
  const blank = length === 0;
  const tooLong = length > maxLength;
  const dirty = trimmed !== saved.trim();
  return { length, blank, tooLong, dirty, canSave: dirty && !blank && !tooLong };
}

export function counterLabel(length: number, maxLength: number): string {
  return `${length.toLocaleString('en-US')} / ${maxLength.toLocaleString('en-US')}`;
}

export function editedLabel(
  view: Pick<AssistantSettingsView, 'isDefault' | 'updatedAt' | 'updatedByName'>,
): string {
  if (view.isDefault) return 'Built-in default';
  const who = view.updatedByName ?? 'a former staff account';
  if (view.updatedAt === null) return `Edited by ${who}`;
  const when = formatGymTime(view.updatedAt, GYM_TIMEZONE, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  });
  return `Edited by ${who} · ${when}`;
}
