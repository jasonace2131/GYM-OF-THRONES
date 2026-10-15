import { Suspense } from 'react';
import type { Metadata } from 'next';
import LoginPage from '@/components/auth/LoginPage';

export const metadata: Metadata = {
  title: 'Sign in — Gym of Thrones',
  description: 'Member and staff access to the Gym of Thrones portal.',
};

/**
 * `useSearchParams()` forces dynamic rendering and MUST sit inside a
 * <Suspense> boundary in Next 16, or `next build` errors. `next` is read inside
 * the client form component; the boundary lives here.
 */
export default function Page() {
  return (
    <Suspense fallback={<div className="auth-split" />}>
      <LoginPage />
    </Suspense>
  );
}
