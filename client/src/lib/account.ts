import {
  PERSON_NAME_PATTERN,
  PH_PHONE_MESSAGE,
  PROFILE_LIMITS,
  collapseSpaces,
  normalisePhPhone,
  type MyProfile,
  type MyProfilePatch,
} from '@got/shared';
import { ApiError, apiFetch } from '@/lib/api';
import { ACCOUNT_DELETED_NOTICE } from '@/lib/accountDeleted';
import { normaliseIdentifier, normalisePassword } from '@/lib/credentials';
import { isPlausibleEmail } from '@/lib/guestEmail';
import {
  meetsPasswordRules,
  newPasswordProblem,
  passwordRefusalMessage,
} from '@/lib/passwordRules';

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

// ── Name and phone (owner, 2026-10-23) ─────────────────────────────────────

export interface DetailsForm {
  firstName: string;
  lastName: string;
  phone: string;
}

export type DetailsField = keyof DetailsForm;

export function detailsForm(profile: MyProfile): DetailsForm {
  return {
    firstName: profile.firstName,
    lastName: profile.lastName,
    phone: profile.phone ?? '',
  };
}

function nameProblem(value: string, which: 'first' | 'last'): string | null {
  if (value === '') return `Enter your ${which} name.`;
  if (value.length > L.nameMax) {
    return `Your ${which} name can be at most ${L.nameMax} characters.`;
  }
  if (!PERSON_NAME_PATTERN.test(value)) {
    return "Use letters, spaces, apostrophes ('), hyphens (-) and dots only.";
  }
  return null;
}

/**
 * Only what changed, like `bodyPatch`, and only a CHANGED field is checked —
 * an empty last name left by an old sign-up must not block saving a phone.
 * Names are trimmed with inner spaces collapsed; the phone is normalised to
 * +639XXXXXXXXX, exactly as the server does, and an emptied phone is `null`.
 */
export function detailsPatch(
  profile: MyProfile,
  form: DetailsForm,
): {
  patch: MyProfilePatch;
  problems: Partial<Record<DetailsField, string>>;
  problem: string | null;
} {
  const patch: MyProfilePatch = {};
  const problems: Partial<Record<DetailsField, string>> = {};

  const first = collapseSpaces(form.firstName);
  if (first !== profile.firstName) {
    const problem = nameProblem(first, 'first');
    if (problem === null) patch.firstName = first;
    else problems.firstName = problem;
  }
  const last = collapseSpaces(form.lastName);
  if (last !== profile.lastName) {
    const problem = nameProblem(last, 'last');
    if (problem === null) patch.lastName = last;
    else problems.lastName = problem;
  }
  // A PH mobile, sent as +639XXXXXXXXX. A legacy number left untouched is
  // not re-checked; an emptied one is `null` (clear it).
  const typed = form.phone.trim();
  if (typed !== (profile.phone ?? '')) {
    if (typed === '') {
      if (profile.phone !== null) patch.phone = null;
    } else {
      const phone = normalisePhPhone(typed);
      if (phone === null) problems.phone = `${PH_PHONE_MESSAGE}.`;
      else if (phone !== profile.phone) patch.phone = phone;
    }
  }

  const firstProblem = problems.firstName ?? problems.lastName ?? problems.phone ?? null;
  return firstProblem === null
    ? { patch, problems, problem: null }
    : { patch: {}, problems, problem: firstProblem };
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
  // The same five rules as every screen that sets a password (lib/passwordRules).
  // Only the NEW one: a current password that predates the rules still opens.
  const problem = newPasswordProblem(wanted, confirm);
  if (problem !== null) {
    return { field: meetsPasswordRules(wanted) ? 'confirm' : 'next', message: problem };
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

type SupabaseResult = { error: { message: string; code?: string } | null };

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
    if (error !== null) {
      return {
        ok: false,
        message: passwordRefusalMessage({
          ...error,
          message: error.message || ACCOUNT_COPY.saveFailed,
        }),
      };
    }
    return { ok: true, message: ACCOUNT_COPY.passwordChanged };
  } catch {
    return { ok: false, message: ACCOUNT_COPY.saveFailed };
  }
}

// ── Delete account (owner, 2026-10-23) ─────────────────────────────────────

/** The one line the home page shows after a deletion (kept import-free there). */
export { ACCOUNT_DELETED_NOTICE };

/** The confirm sheet's warning — only for a plan that is still ACTIVE. */
export function deletePlanWarning(profile: MyProfile): string | null {
  const plan = profile.membership;
  if (plan === null || plan.status !== 'ACTIVE') return null;
  return plan.daysLeft === 1
    ? `Your ${plan.planName} plan has 1 day left. It'll be lost.`
    : `Your ${plan.planName} plan has ${plan.daysLeft} days left. They'll be lost.`;
}

export interface DeleteDeps {
  verify: (email: string, password: string) => Promise<PasswordCheck>;
}

/**
 * Check the password on the throwaway client (as the password change does —
 * the member's own session stays verified), then ask the API, which checks it
 * again against Supabase before it changes anything.
 */
export async function deleteAccount(
  deps: DeleteDeps,
  input: { email: string; password: string },
): Promise<Outcome> {
  const password = normalisePassword(input.password);
  try {
    const check = await deps.verify(input.email, password);
    if (check === 'wrong') return { ok: false, message: ACCOUNT_COPY.wrongPassword };
    if (check === 'error') return { ok: false, message: ACCOUNT_COPY.saveFailed };
    await apiFetch<{ deleted: true }>('/me/delete-account', {
      method: 'POST',
      body: JSON.stringify({ confirm: true, password }),
    });
    return { ok: true, message: ACCOUNT_DELETED_NOTICE };
  } catch (caught) {
    return { ok: false, message: describeSaveFailure(caught) };
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
