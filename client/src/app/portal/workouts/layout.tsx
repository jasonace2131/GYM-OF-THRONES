'use client';

import { MembershipGate } from '@/components/portal/MembershipGate';

/**
 * Every Workouts screen needs an ACTIVE membership (owner, 2026-10-17): locked
 * for somebody who never had one, read-only for a lapsed member. The server
 * enforces it; this explains it.
 */
export default function WorkoutsLayout({ children }: { children: React.ReactNode }) {
  return <MembershipGate feature="workouts">{children}</MembershipGate>;
}
