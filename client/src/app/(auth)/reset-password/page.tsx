import type { Metadata } from 'next';
import ResetPasswordPage from '@/components/auth/ResetPasswordPage';

export const metadata: Metadata = {
  title: 'New password — Gym of Thrones',
  description: 'Set a new password for your Gym of Thrones account.',
};

export default function Page() {
  return <ResetPasswordPage />;
}
