import { GYM_EQUIPMENT_LIMITS } from '@got/shared';

/**
 * The Admin → Settings equipment editor's decisions (owner, 2026-10-23).
 * Pure, so the card only holds strings and shows answers.
 */

export const EQUIPMENT_COPY = {
  empty:
    'No equipment listed. The AI plans with bodyweight and common gym basics until you add some.',
  nameMissing: 'Give the equipment a name.',
  nameLong: `Keep the name to ${GYM_EQUIPMENT_LIMITS.nameMax} characters.`,
  detailLong: `Keep the detail to ${GYM_EQUIPMENT_LIMITS.detailMax} characters.`,
  duplicate: 'That equipment is already on the list.',
} as const;

/** Characters as the API counts them: code points, so an emoji is one. */
const length = (text: string): number => Array.from(text).length;

/**
 * What is wrong with this name and detail, or null. `otherNames` are the
 * names of every OTHER item (exclude the one being edited).
 */
export function equipmentProblem(
  name: string,
  detail: string,
  otherNames: readonly string[],
): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return EQUIPMENT_COPY.nameMissing;
  if (length(trimmed) > GYM_EQUIPMENT_LIMITS.nameMax) return EQUIPMENT_COPY.nameLong;
  if (length(detail.trim()) > GYM_EQUIPMENT_LIMITS.detailMax) return EQUIPMENT_COPY.detailLong;
  const lower = trimmed.toLowerCase();
  if (otherNames.some((other) => other.trim().toLowerCase() === lower)) {
    return EQUIPMENT_COPY.duplicate;
  }
  return null;
}

/** The ids with one moved a step up (-1) or down (+1); null past either end. */
export function moveId(ids: readonly string[], index: number, step: -1 | 1): string[] | null {
  const target = index + step;
  if (index < 0 || index >= ids.length || target < 0 || target >= ids.length) return null;
  const next = [...ids];
  [next[index], next[target]] = [next[target], next[index]];
  return next;
}
