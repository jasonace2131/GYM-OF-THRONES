import { PROFILE_LIMITS, type MyProfile, type MyProfilePatch } from '@got/shared';
import { ApiError, apiFetch } from '@/lib/api';
import { normaliseIdentifier, normalisePassword } from '@/lib/credentials';
import { isPlausibleEmail } from '@/lib/guestEmail';

/**
 * The My account page's decisions — what the wire gets, whether a form may be
 * saved, and what the member is told. Pure, so the page only holds strings and
 * shows answers.
 */

export const ACCOUNT_COPY = {
  saveFailed: "Couldn't save. Try again.",
  emailSent:
    'Check both inboxes — we sent a confirmation link. Your email changes once you open it.',
  wrongPassword: "That's not your current password.",
  passwordChanged: 'Password changed.',
  shareLabel: 'Let the workout planner use my medical notes',
  shareHelper:
    'Your notes go to the AI that writes your plans so it avoids exercises that could hurt you. Off: they stay on your account and the AI never sees them.',
} as const;

/** Same floor as reset-password, join and invite — the screens that set a password. */
export const PASSWORD_MIN = 8;

const L = PROFILE_LIMITS;

export interface BodyForm {
  height: string;
  weight: string;
  notes: string;
  /** "Let the workout planner use my medical notes". */
  share: boolean;
}

export type BodyField = 'height' | 'weight' | 'notes';

export function bodyForm(profile: MyProfile): BodyForm {
  return {
    height: profile.heightCm === null ? '' : String(profile.heightCm),
    weight: profile.weightKg === null ? '' : String(profile.weightKg),
    notes: profile.medicalNotes ?? '',
    share: profile.shareMedicalWithPlanner,
  };
}

type Parsed = { value: number | null } | { problem: string };

function parseMeasure(
  raw: string,
  label: string,
  unit: string,
  min: number,
  max: number,
  example: string,
): Parsed {
  const text = raw.trim().replace(',', '.');
  if (text === '') return { value: null };
  if (!/^\d+(\.\d+)?$/.test(text)) {
    return { problem: `${label} must be a number, like ${example}.` };
  }
  if (!/^\d+(\.\d)?$/.test(text)) {
    return { problem: `${label} can have one decimal at most, like ${example}.` };
  }
  const value = Number(text);
  if (value < min || value > max) {
    return { problem: `${label} must be between ${min} and ${max} ${unit}.` };
  }
  return { value };
}

/**
 * Only what changed, so a save never rewrites a value the member did not
 * touch. An emptied field is `null` (clear it); notes are trimmed.
 *
 * ONLY A CHANGED FIELD IS CHECKED. A value stored by sign-up or by staff that
 * this form would not accept as typed (two decimals, say) must never block
 * saving the other fields. `problems` is per field, for the field's own
 * message; `problem` is the first of them.
 */
export function bodyPatch(
  profile: MyProfile,
  form: BodyForm,
): { patch: MyProfilePatch; problems: Partial<Record<BodyField, string>>; problem: string | null } {
  const original = bodyForm(profile);
  const patch: MyProfilePatch = {};
  const problems: Partial<Record<BodyField, string>> = {};

  if (form.height.trim() !== original.height) {
    const height = parseMeasure(form.height, 'Height', 'cm', L.heightCmMin, L.heightCmMax, '175.5');
    if ('problem' in height) problems.height = height.problem;
    else if (height.value !== profile.heightCm) patch.heightCm = height.value;
  }
  if (form.weight.trim() !== original.weight) {
    const weight = parseMeasure(form.weight, 'Weight', 'kg', L.weightKgMin, L.weightKgMax, '72.5');
    if ('problem' in weight) problems.weight = weight.problem;
    else if (weight.value !== profile.weightKg) patch.weightKg = weight.value;
  }

  const trimmed = form.notes.trim();
  if (trimmed.length > L.medicalNotesMax) {
    problems.notes = `Medical notes can be at most ${L.medicalNotesMax} characters.`;
  } else {
    const notes = trimmed === '' ? null : trimmed;
    if (notes !== profile.medicalNotes) patch.medicalNotes = notes;
  }

  if (form.share !== profile.shareMedicalWithPlanner) {
    patch.shareMedicalWithPlanner = form.share;
  }

  const first = problems.height ?? problems.weight ?? problems.notes ?? null;
  return first === null
    ? { patch, problems, problem: null }
    : { patch: {}, problems, problem: first };
}

/**
 * The line after a save — true to what happens next: the member's height and
 * weight are their current numbers for their coach and the planner (owner,
 * 2026-10-20), and the notes reach the planner only when shared.
 */
export function bodySavedMessage(profile: MyProfile): string {
  const base = 'Saved. Your coach and your next workout plan use your height and weight';
  return profile.shareMedicalWithPlanner
    ? `${base}, and the planner reads your medical notes.`
    : `${base}.`;
}

export function getProfile(): Promise<MyProfile> {
  return apiFetch<MyProfile>('/me/profile');
}

/** Send only what `bodyPatch` found changed. */
export function saveProfile(patch: MyProfilePatch): Promise<MyProfile> {
  return apiFetch<MyProfile>('/me/profile', { method: 'PATCH', body: JSON.stringify(patch) });
}

export type PasswordField = 'current' | 'next' | 'confirm';

/** What is wrong, and on which field — so that field alone is marked invalid. */
export function passwordIssue(
  current: string,
  next: string,
  confirm: string,
): { field: PasswordField; message: string } | null {
  const now = normalisePassword(current);
  const wanted = normalisePassword(next);
  if (now === '') return { field: 'current', message: 'Enter your current password.' };
  if (wanted.length < PASSWORD_MIN) {
    return { field: 'next', message: `Use at least ${PASSWORD_MIN} characters.` };
  }
  if (wanted !== normalisePassword(confirm)) {
    return { field: 'confirm', message: 'The two passwords do not match.' };
  }
  if (wanted === now) {
    return { field: 'next', message: 'Choose a password different from your current one.' };
  }
  return null;
}

export function passwordProblem(current: string, next: string, confirm: string): string | null {
  return passwordIssue(current, next, confirm)?.message ?? null;
}

export function emailProblem(current: string, next: string): string | null {
  const wanted = normaliseIdentifier(next);
  if (!isPlausibleEmail(wanted)) return 'Enter a valid email address.';
  if (wanted === normaliseIdentifier(current)) return 'That is already your email.';
  return null;
}

/** A 4xx says what was wrong; anything else is the generic line. */
export function describeSaveFailure(caught: unknown): string {
  if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500) {
    return caught.message;
  }
  return ACCOUNT_COPY.saveFailed;
}

export interface Outcome {
  ok: boolean;
  message: string;
}

/** `ok` — right password; `wrong` — refused as a bad credential; `error` — could not tell. */
export type PasswordCheck = 'ok' | 'wrong' | 'error';

type SupabaseResult = { error: { message: string } | null };

export interface PasswordDeps {
  verify: (email: string, password: string) => Promise<PasswordCheck>;
  update: (password: string) => Promise<SupabaseResult>;
}

/**
 * Check the current password, then set the new one. `verify` must NOT
 * replace the browser's session (see `accountAuth.ts`): a new session is an
 * unverified sign-in, and the next API call would send the member to the
 * emailed-code step.
 */
export async function changePassword(
  deps: PasswordDeps,
  input: { email: string; current: string; next: string },
): Promise<Outcome> {
  try {
    const check = await deps.verify(input.email, normalisePassword(input.current));
    if (check === 'wrong') return { ok: false, message: ACCOUNT_COPY.wrongPassword };
    if (check === 'error') return { ok: false, message: ACCOUNT_COPY.saveFailed };
    const { error } = await deps.update(normalisePassword(input.next));
    if (error !== null) return { ok: false, message: error.message || ACCOUNT_COPY.saveFailed };
    return { ok: true, message: ACCOUNT_COPY.passwordChanged };
  } catch {
    return { ok: false, message: ACCOUNT_COPY.saveFailed };
  }
}

export interface EmailDeps {
  update: (email: string) => Promise<SupabaseResult>;
}

/** Supabase sends the confirmation; our copy of the address follows the token. */
export async function changeEmail(deps: EmailDeps, next: string): Promise<Outcome> {
  try {
    const { error } = await deps.update(normaliseIdentifier(next));
    if (error !== null) return { ok: false, message: error.message || ACCOUNT_COPY.saveFailed };
    return { ok: true, message: ACCOUNT_COPY.emailSent };
  } catch {
    return { ok: false, message: ACCOUNT_COPY.saveFailed };
  }
}
