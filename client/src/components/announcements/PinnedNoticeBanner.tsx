'use client';

import { useRouter } from 'next/navigation';
import { noticeHref } from '@/lib/announcements/focus';
import { previewText } from '@/lib/announcements/preview';
import { cn } from '@/lib/utils';
import { useAnnouncements } from './AnnouncementsProvider';

/**
 * The newest pinned notice, above the status band — on narrow layouts only.
 *
 * On a phone the noticeboard sits below the fold, under the plan, the stats
 * and the classes; a pinned notice ("closed Monday") is exactly the thing a
 * member must not scroll past. Wide layouts already show the board beside the
 * status band, so the dashboard hides this there (`@3xl:hidden`).
 *
 * An `<aside>` with a label and no heading: it is a pointer to a notice, not a
 * section of the page. "Read" opens it on the board below via the same
 * `?notice=` deep link the bell uses, replacing the URL without scrolling to
 * the top first.
 */
export function PinnedNoticeBanner({ className }: { className?: string }) {
  const { state, noticesHome } = useAnnouncements();
  const router = useRouter();
  const pinned = state.pinned[0];
  if (pinned === undefined) return null;

  return (
    <aside
      aria-label="Pinned announcement"
      className={cn(
        'flex items-center gap-3 rounded-[var(--p-radius)] border border-[rgba(201,146,42,0.32)] bg-[var(--p-warn-bg)] py-2 pr-2 pl-3.5',
        className,
      )}
    >
      <svg
        aria-hidden
        viewBox="0 0 24 24"
        className="size-4 shrink-0 fill-none stroke-gold-deep stroke-2"
      >
        <path
          d="M9 4h6l-1 6 3 3v2H7v-2l3-3-1-6ZM12 15v5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <p className="m-0 min-w-0 flex-1 truncate text-[13.5px] text-ink-2">
        <span className="font-semibold text-foreground">{pinned.title}</span>
        <span aria-hidden className="text-muted-foreground">
          {' — '}
          {previewText(pinned.content, 120)}
        </span>
      </p>
      <button
        type="button"
        onClick={() => router.replace(noticeHref(pinned.id, noticesHome), { scroll: false })}
        className="inline-flex min-h-11 shrink-0 cursor-pointer items-center rounded-md px-3 text-[13px] font-semibold text-gold-deep transition-[color,background-color,border-color] hover:bg-[rgba(201,146,42,0.12)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold"
      >
        Read
        <span className="sr-only">: {pinned.title}</span>
      </button>
    </aside>
  );
}
