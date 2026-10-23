'use client';

import { MembershipGate } from '@/components/portal/MembershipGate';

/**
 * My Progress needs an ACTIVE membership (owner, 2026-10-17): locked for
 * somebody who never had one; a lapsed member keeps their history. The page
 * writes nothing for a member (their coach records progress).
 */
export default function ProgressLayout({ children }: { children: React.ReactNode }) {
  return <MembershipGate feature="progress">{children}</MembershipGate>;
}
