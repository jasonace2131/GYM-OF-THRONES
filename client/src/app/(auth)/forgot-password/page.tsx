import type { Metadata } from 'next';
import ForgotPasswordPage from '@/components/auth/ForgotPasswordPage';

export const metadata: Metadata = {
  title: 'Reset password — Gym of Thrones',
  description: 'Request a password reset link for your Gym of Thrones account.',
};

export default function Page() {
  return <ForgotPasswordPage />;
}
