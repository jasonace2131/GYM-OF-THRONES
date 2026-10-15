'use client';

import { useRef, useState } from 'react';
import type { MemberNoticeWire } from '@got/shared';
import { IconBell } from '@/components/portal/icons';
import { Popover, PopoverTrigger } from '@/components/ui/popover';
import { bellLabel, unreadBadge, type BellNoun } from '@/lib/announcements/unread';
import { bellRows, seenMarks } from '@/lib/notices/bell';
import { cn } from '@/lib/utils';
import { AnnouncementsPanel } from './AnnouncementsPanel';
import { useAnnouncements } from './AnnouncementsProvider';
import { useMemberNoticesOptional } from './MemberNoticesProvider';

const NO_NOTICES: readonly MemberNoticeWire[] = [];

/**
 * The topbar bell — a real count, backed by `GET /me/announcements` and, in
 * the member portal, `GET /me/notices` (the member's own: a seat that opened
 * up, a class called off). The console mounts it with announcements only; it
 * reads the notices feed through an optional hook and works without it.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE BADGE IS DECORATION; THE NAME IS THE MEANING.
 *
 * The red pill is `aria-hidden` and caps at "9+". The button's accessible
 * name carries the state as a phrase ("Notifications, 3 new"), so a screen
 * reader hears what the three ARE. One polite status region, for both feeds,
 * speaks only when a count rises while the member is here — it is not a live
 * badge that re-announces on every render, and two feeds never make it speak
 * twice.
 * ─────────────────────────────────────────────────────────────────────────
 *
 * OPENING IT IS "SEEN". Each feed refreshes if stale; then each marks seen up
 * to its own newest row ON SCREEN — never "now", and nothing for a feed whose
 * rows the other pushed below the cut (`seenMarks`). The count drops to zero
 * at once; the dots stay lit until the dropdown closes, so the member can
 * still see which rows were new.
 *
 * Geometry matches `.p-surface-switch` beside it (34px, 9px radius), and an
 * `::after` extends the hit area to 44x44 without growing the topbar. The bell
 * goes away only when no feed it reads may be read by this account (403s
 * everywhere) — a control that cannot work is worse than none.
 */
export function NotificationBell() {
  const announcements = useAnnouncements();
  const notices = useMemberNoticesOptional();
  const [open, setOpen] = useState(false);
  /** Bumped on every open and close: a mark worked out for an open that has
   *  since closed is dropped, because the rows it names were never shown. */
  const opening = useRef(0);

  const noun: BellNoun = notices === null ? 'announcement' : 'notification';
  // Each feed counts only its own rows, so the sum counts nothing twice.
  const count = announcements.state.unreadCount + (notices?.state.unreadCount ?? 0);

  // The one status region: speak when either feed's count ROSE on a refresh,
  // and say the total the badge now shows. Tracked as the previous render's
  // value (React's "storing information from previous renders"), not in an
  // effect, so it lands in the same render as the new badge. A zero total —
  // the member is looking at the open dropdown, its mark in flight — says
  // nothing: the new rows are on their screen already.
  const rises = announcements.rises + (notices?.rises ?? 0);
  const [heard, setHeard] = useState(rises);
  const [message, setMessage] = useState<string | null>(null);
  if (rises !== heard) {
    setHeard(rises);
    if (rises > heard && count > 0) setMessage(unreadBadge(count, noun).spoken);
  }

  if (announcements.state.forbidden && (notices === null || notices.state.forbidden)) return null;

  const badge = unreadBadge(count, noun);

  const onOpenChange = (next: boolean): void => {
    setOpen(next);
    opening.current += 1;
    if (!next) {
      announcements.closePanel();
      notices?.closePanel();
      return;
    }
    setMessage(null);
    const generation = opening.current;
    void Promise.all([
      announcements.openPanel(),
      notices?.openPanel() ?? Promise.resolve(NO_NOTICES),
    ]).then(([shownAnnouncements, shownNotices]) => {
      if (opening.current !== generation) return;
      const marks = seenMarks(bellRows(shownAnnouncements, shownNotices));
      if (marks.announcements !== null) announcements.markSeen(marks.announcements);
      if (marks.notices !== null) notices?.markSeen(marks.notices);
    });
  };

  return (
    <>
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={bellLabel(count, noun)}
            className={cn(
              'relative grid size-[34px] shrink-0 cursor-pointer place-items-center rounded-[9px] border border-border bg-card text-ink-2 transition-[color,border-color]',
              'hover:border-gold hover:text-foreground data-[state=open]:border-gold data-[state=open]:text-foreground',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-gold',
              "after:absolute after:-inset-[5px] after:content-['']",
            )}
          >
            <IconBell size={17} />
            {badge.text !== null ? (
              <span
                aria-hidden
                className="pointer-events-none absolute -top-[7px] -right-[7px] grid h-[18px] min-w-[18px] place-items-center rounded-full bg-danger px-[5px] font-display text-[10.5px] font-bold leading-none tabular-nums text-white ring-2 ring-[var(--p-paper2)]"
              >
                {badge.text}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <AnnouncementsPanel onNavigate={() => onOpenChange(false)} />
      </Popover>
      <span role="status" className="sr-only">
        {message ?? ''}
      </span>
    </>
  );
}
