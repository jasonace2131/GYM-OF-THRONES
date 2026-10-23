'use client';

import { MembershipGate } from '@/components/portal/MembershipGate';

/**
 * My Coach needs an ACTIVE membership (owner, 2026-10-17): locked for
 * somebody who never had one; a lapsed member can read the conversation but
 * not send. The server enforces it; this explains it.
 */
export default function CoachLayout({ children }: { children: React.ReactNode }) {
  return <MembershipGate feature="coach">{children}</MembershipGate>;
}
