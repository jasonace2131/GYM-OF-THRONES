import { COACH_PROFILE_LIMITS, type CoachProfileView } from '@got/shared';

/**
 * The coach-profile form, everything but the pixels.
 *
 * The limits are the database's own (`CoachProfile_*_shape`, re-exported as
 * `COACH_PROFILE_LIMITS`), so the Save button never offers a profile the
 * server would refuse. Specializations are typed as one comma-separated line:
 * five short tags do not need a chip editor.
 */

/** The form as typed. */
export interface ProfileDraft {
  specializations: string;
  bio: string;
}

/** Split, trim, drop blanks, keep the first spelling of a case-insensitive repeat. */
export function parseSpecializations(input: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input.split(/[,\n]/)) {
    const tag = raw.trim();
    const key = tag.toLowerCase();
    if (tag === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** The sentence under the form, or null when it may be saved. */
export function draftProblem(draft: ProfileDraft): string | null {
  const tags = parseSpecializations(draft.specializations);
  if (tags.length > COACH_PROFILE_LIMITS.specializations) {
    return `At most ${COACH_PROFILE_LIMITS.specializations} specializations.`;
  }
  const long = tags.find((tag) => tag.length > COACH_PROFILE_LIMITS.specializationLength);
  if (long !== undefined) {
    return `"${long.slice(0, 20)}…" is over ${COACH_PROFILE_LIMITS.specializationLength} characters.`;
  }
  if (draft.bio.trim().length > COACH_PROFILE_LIMITS.bioLength) {
    return `The bio is over ${COACH_PROFILE_LIMITS.bioLength} characters.`;
  }
  return null;
}

/** What `PUT /admin/coaches/:id/profile` receives. A blank bio clears it. */
export function draftToBody(draft: ProfileDraft): {
  specializations: string[];
  bio: string | null;
} {
  const bio = draft.bio.trim();
  return {
    specializations: parseSpecializations(draft.specializations),
    bio: bio === '' ? null : bio,
  };
}

export function draftFromProfile(profile: CoachProfileView | undefined): ProfileDraft {
  return {
    specializations: (profile?.specializations ?? []).join(', '),
    bio: profile?.bio ?? '',
  };
}

/** "Strength · Mobility", for a card. Empty when there are none. */
export function specializationsLine(tags: readonly string[] | undefined): string {
  return (tags ?? []).join(' · ');
}

/** The coach assign picker's option text. */
export function coachOptionLabel(
  coach: { firstName: string; lastName: string },
  tags: readonly string[] | undefined,
): string {
  const name = `${coach.firstName} ${coach.lastName}`.trim();
  return tags === undefined || tags.length === 0 ? name : `${name} — ${tags.join(', ')}`;
}
