import type { MemberAccess } from '@got/shared';

/**
 * Member-only features — Workouts, Ask the Gym, My Progress, My Coach — need
 * an ACTIVE membership (owner, 2026-10-17). The SERVER decides it and says so
 * on `GET /me` as `memberAccess`; this file only reads that answer and holds
 * the copy. The gate itself is the server's (`403 MEMBERSHIP_REQUIRED`), so
 * nothing here is a security control.
 */

/** Null while `/me` is loading. */
export function memberAccessOf(me: { memberAccess?: MemberAccess } | null): MemberAccess | null {
  if (me === null) return null;
  // An API older than the field: fall open, as the server still gates.
  return me.memberAccess ?? 'FULL';
}

export type GatedFeature = 'workouts' | 'assistant' | 'progress' | 'coach';

/** Where a member buys or renews a plan — the dashboard's "Renew" goes there too. */
export const RENEW_HREF = '/portal/subscription';

/** The owner's words for the read-only notice. */
export const MEMBERSHIP_NOTICE = "Your membership isn't active. Renew to keep using this.";

/** The locked page: a short title and one line on what the feature does. */
export const FEATURE_COPY: Record<GatedFeature, { title: string; line: string }> = {
  workouts: {
    title: 'Workouts are for members',
    line: 'Build a weekly workout plan with AI and log every session as you train.',
  },
  assistant: {
    title: 'Ask the Gym is for members',
    line: 'Ask about classes, opening hours, your plan and your training, any time.',
  },
  progress: {
    title: 'My Progress is for members',
    line: 'See the measurements and goals your coach records, and how you are trending.',
  },
  coach: {
    title: 'My Coach is for members',
    line: 'See who coaches you and message them directly.',
  },
};
