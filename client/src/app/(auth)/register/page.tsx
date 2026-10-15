import { Suspense } from 'react';
import type { Metadata } from 'next';
import RegisterPage from '@/components/auth/RegisterPage';

export const metadata: Metadata = {
  title: 'Join — Gym of Thrones',
  description: 'Create a Gym of Thrones member account.',
};

export default function Page() {
  return (
    <Suspense fallback={<div className="auth-split" />}>
      <RegisterPage />
    </Suspense>
  );
}
