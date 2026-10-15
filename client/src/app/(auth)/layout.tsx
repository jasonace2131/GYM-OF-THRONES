import type { ReactNode } from 'react';

/**
 * A route group, so `/login` and `/register` inherit neither the portal shell
 * nor `portal.css`. The parentheses keep the segment out of the URL: these are
 * `/login` and `/register`, not `/(auth)/login`.
 *
 * Global styles come from the root layout, which is where `globals.css` — and
 * therefore `.auth-split` — is imported.
 */
export default function AuthLayout({ children }: { children: ReactNode }) {
  return children;
}
