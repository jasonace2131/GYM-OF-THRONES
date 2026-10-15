'use client';

import { useId, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { MemberAnnouncement, MemberNoticeWire } from '@got/shared';
import { PopoverContent } from '@/components/ui/popover';
import { useMediaQuery } from '@/lib/useMediaQuery';
import { hasNewDots } from '@/lib/announcements/feed';
import { allNoticesHref } from '@/lib/announcements/focus';
import { previewText } from '@/lib/announcements/preview';
import { absoluteTime, relativeTime } from '@/lib/announcements/time';
import {
  bellRowHref,
  bellRowKey,
  bellRows,
  bellView,
  type BellFeedStatus,
} from '@/lib/notices/bell';
import { hasNewNotices } from '@/lib/notices/feed';
import { cn } from '@/lib/utils';
import { useAnnouncements } from './AnnouncementsProvider';
import { useMemberNoticesOptional } from './MemberNoticesProvider';

/** Every row's grid: the dot, the words, the time. */
const ROW =
  'grid min-h-14 grid-cols-[8px_minmax(0,1fr)_auto] items-start gap-x-3 px-4 py-3 text-foreground';
/** What a row that goes somewhere adds. */
const ROW_LINK =
  'group no-underline transition-[color,background-color] hover:bg-muted hover:text-foreground focus-visible:bg-muted focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold';

/**
 * The bell's dropdown — GitHub/Facebook style: a header with "Mark all read",
 * the newest rows, and a link to the noticeboard at the foot.
 *
 * TWO FEEDS, ONE LIST. In the member portal the rows are the gym's
 * announcements AND the member's own notices, merged newest first and cut at
 * eight (`bellRows`), under the neutral heading "Notifications". The console
 * has no notices provider, so there it lists announcements alone, under
 * "Announcements".
 *
 * Reading an announcement does not happen here (owner decision): its row, and
 * the foot link, go to the dashboard, which expands the notice and scrolls it
 * into view. On the dashboard itself that link REPLACES the URL and does not
 * scroll — the page reacts to `?notice=` in place, with no remount and no
 * refetch. A member's notice is different: the bell is the only place it is
 * listed, so its row shows the whole sentence, and it links to its own
 * `linkPath` (the day in Book a class), never to the noticeboard.
 */
export function AnnouncementsPanel({ onNavigate }: { onNavigate: () => void }) {
  const announcements = useAnnouncements();
  const notices = useMemberNoticesOptional();
  const { noticesHome } = announcements;
  const pathname = usePathname();
  const headingId = useId();
  const heading = useRef<HTMLHeadingElement>(null);
  const navigating = useRef(false);
  // Keep the panel clear of the phone tab bar (fixed, 52px + safe area).
  const phone = useMediaQuery('(max-width: 900px)');

  const a = announcements.state;
  const n = notices?.state ?? null;
  // The member's own notices are in this bell — the portal's.
  const personal = notices !== null;
  // The dashboard this surface reads notices on — the portal's or the
  // console's — so a link never crosses surfaces.
  const onDashboard = pathname === noticesHome;
  const rows = bellRows(a.forbidden ? [] : a.items, n === null || n.forbidden ? [] : n.items);
  const feeds: BellFeedStatus[] = n === null ? [a] : [a, n];
  const { view, partialFailure } = bellView(feeds, rows.length);
  const dots = hasNewDots(a) || (n !== null && hasNewNotices(n));
  const now = new Date();

  const follow = (): void => {
    navigating.current = true;
    onNavigate();
  };

  const retry = (): void => {
    // A 403 is this account's answer; asking again would only repeat it.
    if (!a.forbidden) announcements.retry();
    if (notices !== null && !notices.state.forbidden) notices.retry();
  };

  return (
    <PopoverContent
      align="end"
      sideOffset={8}
      collisionPadding={{ top: 8, right: 8, left: 8, bottom: phone ? 76 : 8 }}
      aria-labelledby={headingId}
      onCloseAutoFocus={(event) => {
        // A row or the foot link hands focus to where it goes; snapping it
        // back to the bell would steal it. Esc and outside-click still return
        // focus to the bell as usual.
        if (navigating.current) event.preventDefault();
        navigating.current = false;
      }}
      className="flex w-[min(24rem,calc(100vw-1rem))] max-h-[min(32rem,var(--radix-popover-content-available-height))] flex-col overflow-hidden rounded-[var(--p-radius)] p-0 shadow-[var(--p-shadow-lift)]"
    >
      <header className="flex min-h-[52px] shrink-0 items-center justify-between gap-3 border-b border-border pl-4 pr-2">
        <h2
          id={headingId}
          ref={heading}
          tabIndex={-1}
          className="m-0 font-display text-[15px] font-bold tracking-[-0.01em] text-foreground outline-none"
        >
          {personal ? 'Notifications' : 'Announcements'}
        </h2>
        {dots ? (
          <button
            type="button"
            onClick={() => {
              // Both feeds: every dot in this list goes, whichever store it
              // came from.
              announcements.markAllRead();
              notices?.markAllRead();
              // The button is about to disappear; do not drop focus on <body>.
              heading.current?.focus();
            }}
            className="inline-flex min-h-11 cursor-pointer items-center rounded-md px-2.5 text-[12.5px] font-semibold text-gold-deep transition-[color,background-color,border-color] hover:bg-accent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold"
          >
            Mark all read
          </button>
        ) : null}
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        {view === 'loading' ? (
          <PanelSkeleton />
        ) : view === 'error' ? (
          <div className="px-5 py-8 text-center">
            <p className="m-0 text-sm font-semibold text-ink-2">
              {personal ? 'Couldn’t load notifications' : 'Couldn’t load announcements'}
            </p>
            <p className="mt-1 mb-4 text-[13px] text-muted-foreground">
              Check your connection, then try again.
            </p>
            <button type="button" onClick={retry} className="p-btn p-btn-ghost p-btn-sm">
              Try again
            </button>
          </div>
        ) : view === 'empty' ? (
          <p className="m-0 px-5 py-8 text-center text-[13.5px] leading-relaxed text-muted-foreground">
            {personal
              ? 'Nothing yet — news from the gym and updates about your class bookings will show up here.'
              : 'No announcements yet — closures, schedule changes and events from the gym will show up here.'}
          </p>
        ) : (
          <>
            <ul className="m-0 list-none p-0">
              {rows.map((row) => (
                <li key={bellRowKey(row)} className="border-b border-border last:border-b-0">
                  {row.source === 'announcement' ? (
                    <AnnouncementRow
                      notice={row.item}
                      now={now}
                      href={bellRowHref(row, noticesHome)}
                      onDashboard={onDashboard}
                      onFollow={follow}
                    />
                  ) : (
                    <MemberNoticeRow
                      notice={row.item}
                      now={now}
                      href={bellRowHref(row, noticesHome)}
                      onFollow={follow}
                    />
                  )}
                </li>
              ))}
            </ul>
            {partialFailure ? (
              // One feed arrived and the other did not: say so rather than
              // pass the shorter list off as everything.
              <p className="m-0 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-t border-border px-4 py-2.5 text-[13px] text-muted-foreground">
                Some notifications couldn&rsquo;t load.
                <button type="button" onClick={retry} className="p-btn p-btn-ghost p-btn-sm">
                  Try again
                </button>
              </p>
            ) : null}
          </>
        )}
      </div>

      {a.forbidden ? null : (
        <footer className="shrink-0 border-t border-border">
          <Link
            href={allNoticesHref(noticesHome)}
            replace={onDashboard}
            scroll={!onDashboard}
            onClick={follow}
            className="flex min-h-11 items-center justify-center gap-1.5 text-[13px] font-semibold text-gold-deep transition-[color,background-color,border-color] hover:bg-muted hover:text-gold-deep focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-gold"
          >
            {/* The noticeboard lists announcements only; in a bell that also
                carries the member's own notices, "View all" would promise
                rows it does not have. */}
            {personal ? 'All announcements' : 'View all'} <span aria-hidden>→</span>
          </Link>
        </footer>
      )}
    </PopoverContent>
  );
}

/** The dot, lit for a row still new — the words carry "New" for everyone else. */
function Dot({ lit }: { lit: boolean }) {
  return (
    <span
      aria-hidden
      className={cn('mt-[7px] size-2 rounded-full', lit ? 'bg-gold' : 'bg-transparent')}
    />
  );
}

function Stamp({ iso, now }: { iso: string; now: Date }) {
  return (
    <time
      dateTime={iso}
      title={absoluteTime(iso)}
      className="whitespace-nowrap pt-px text-[12px] tabular-nums text-muted-foreground"
    >
      {relativeTime(iso, now)}
    </time>
  );
}

function AnnouncementRow({
  notice,
  now,
  href,
  onDashboard,
  onFollow,
}: {
  notice: MemberAnnouncement;
  now: Date;
  href: string;
  onDashboard: boolean;
  onFollow: () => void;
}) {
  return (
    <Link
      href={href}
      replace={onDashboard}
      scroll={!onDashboard}
      onClick={onFollow}
      className={cn(ROW, ROW_LINK)}
    >
      <Dot lit={notice.isNew} />
      <span className="min-w-0">
        <span
          className={cn(
            'block truncate text-[14px] leading-snug',
            notice.isNew ? 'font-semibold text-foreground' : 'font-medium text-ink-2',
          )}
        >
          {notice.isNew ? <span className="sr-only">New: </span> : null}
          {notice.title}
        </span>
        <span className="mt-0.5 line-clamp-1 text-[13px] leading-snug text-muted-foreground">
          {previewText(notice.content, 140)}
        </span>
        {notice.isPinned ? (
          <span className="mt-1.5 inline-block font-display text-[10px] font-semibold uppercase tracking-[0.14em] text-gold-deep">
            Pinned
          </span>
        ) : null}
      </span>
      <Stamp iso={notice.createdAt} now={now} />
    </Link>
  );
}

/**
 * One of the member's own notices. The title and body are sentences the
 * server wrote in gym time when the thing happened, and this bell is the only
 * place they are listed — so both are shown whole, wrapped rather than cut
 * ("You're in: Yoga, Tue 14 Oct 7:00 AM" loses the part that matters to a
 * truncation). A notice with no usable link is a plain row: nothing to open.
 */
function MemberNoticeRow({
  notice,
  now,
  href,
  onFollow,
}: {
  notice: MemberNoticeWire;
  now: Date;
  href: string | null;
  onFollow: () => void;
}) {
  const content: ReactNode = (
    <>
      <Dot lit={notice.isNew} />
      <span className="min-w-0">
        <span
          className={cn(
            'block text-[14px] leading-snug [overflow-wrap:anywhere]',
            notice.isNew ? 'font-semibold text-foreground' : 'font-medium text-ink-2',
          )}
        >
          {notice.isNew ? <span className="sr-only">New: </span> : null}
          {notice.title}
        </span>
        {notice.body !== null ? (
          <span className="mt-0.5 block whitespace-pre-wrap text-[13px] leading-snug text-muted-foreground [overflow-wrap:anywhere]">
            {notice.body}
          </span>
        ) : null}
      </span>
      <Stamp iso={notice.createdAt} now={now} />
    </>
  );

  return href === null ? (
    <div className={ROW}>{content}</div>
  ) : (
    <Link href={href} onClick={onFollow} className={cn(ROW, ROW_LINK)}>
      {content}
    </Link>
  );
}

function PanelSkeleton() {
  return (
    <div aria-hidden className="grid">
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="grid grid-cols-[8px_minmax(0,1fr)_40px] gap-x-3 border-b border-border px-4 py-3.5 last:border-b-0"
        >
          <span />
          <span className="grid gap-2">
            <span className="h-3.5 w-3/4 animate-pulse rounded bg-secondary" />
            <span className="h-3 w-full animate-pulse rounded bg-muted" />
          </span>
          <span className="h-3 animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
