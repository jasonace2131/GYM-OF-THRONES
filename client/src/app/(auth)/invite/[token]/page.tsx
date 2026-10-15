import type { Metadata } from 'next';
import InvitePage from '@/components/auth/InvitePage';

export const metadata: Metadata = {
  title: 'Your staff invitation — Gym of Thrones',
  description: 'Accept your invitation to join the Gym of Thrones staff.',
  // A link carrying a secret is nobody's search result.
  robots: { index: false, follow: false },
};

/**
 * `/invite/<token>` — a staff invitation. Inside the `(auth)` group so it
 * shares the sign-in pages' look and none of the portal's shell.
 *
 * Next 16: `params` is a Promise on a server page. The token is untrusted
 * input — the page only ever sends it back to the API, which looks it up by
 * its hash.
 */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <InvitePage token={token} />;
}
