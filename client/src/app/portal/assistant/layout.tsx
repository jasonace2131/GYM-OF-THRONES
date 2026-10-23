'use client';

import { MembershipGate } from '@/components/portal/MembershipGate';

/**
 * Ask the Gym needs an ACTIVE membership (owner, 2026-10-17): locked for
 * somebody who never had one; a lapsed member can read past chats but not
 * ask. The server enforces it; this explains it.
 */
export default function AssistantLayout({ children }: { children: React.ReactNode }) {
  return <MembershipGate feature="assistant">{children}</MembershipGate>;
}
