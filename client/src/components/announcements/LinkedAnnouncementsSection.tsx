'use client';

import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { parseNoticeFocus } from '@/lib/announcements/focus';
import { AnnouncementsSection } from './AnnouncementsSection';

/**
 * The noticeboard, reading its own `?notice=` deep link.
 *
 * For a page that is not the member dashboard — the console dashboard and the
 * coach dashboard — so the bell's rows land on a board that opens the notice.
 * Once the link has been acted on it is dropped from the URL without a scroll.
 *
 * `useSearchParams` means it MUST sit under a `<Suspense>` boundary, or
 * `next build` fails on a prerendered route; the caller owns that boundary so
 * the rest of its page is not held back by it.
 */
export function LinkedAnnouncementsSection({ className }: { className?: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const focus = parseNoticeFocus(searchParams.get('notice'));

  const clearFocus = useCallback((): void => {
    router.replace(pathname, { scroll: false });
  }, [router, pathname]);

  return <AnnouncementsSection focus={focus} onFocusHandled={clearFocus} className={className} />;
}
