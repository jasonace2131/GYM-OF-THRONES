'use client';

import type { NavBadge } from '@/components/portal/nav';
import { messagesBadge } from '@/lib/chat/badge';
import { useNavBadges } from './RealtimeProvider';

/**
 * The unread pill on a nav item, a tab or a More-sheet row.
 *
 * Renders nothing for an item with no `badge`, outside the portal's
 * `RealtimeProvider` (the console), and at zero — a badge is only ever backed
 * by a real count. The pill is decoration; the words are for screen readers.
 */
export function NavItemBadge({ badge }: { badge?: NavBadge }) {
  const counts = useNavBadges();
  if (badge === undefined) return null;
  const { text, spoken } = messagesBadge(counts[badge] ?? 0);
  if (text === null) return null;
  return (
    <>
      <span className="p-nav-badge" aria-hidden>
        {text}
      </span>
      <span className="sr-only">, {spoken}</span>
    </>
  );
}
