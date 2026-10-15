import type { Metadata } from 'next';
import JoinPage from '@/components/auth/JoinPage';

export const metadata: Metadata = {
  title: 'Set up your account — Gym of Thrones',
  description: 'Finish setting up your Gym of Thrones membership account.',
  // A link carrying a secret is nobody's search result.
  robots: { index: false, follow: false },
};

/**
 * `/join/<token>` — a member's setup link, from the email the front desk's
 * "Create member" sends. Inside `(auth)` so it shares the sign-in pages' look.
 * Next 16: `params` is a Promise. The token is only ever sent back to the API.
 */
export default async function Page({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <JoinPage token={token} />;
}
