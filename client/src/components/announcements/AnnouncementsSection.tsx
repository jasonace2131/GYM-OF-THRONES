'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { CardHead, EmptyState } from '@/components/portal/ui';
import { fetchAnnouncement } from '@/lib/announcements/api';
import { canLoadMore, sectionItems } from '@/lib/announcements/feed';
import { noticeDomId, type NoticeFocus } from '@/lib/announcements/focus';
import { cn } from '@/lib/utils';
import { useAnnouncements } from './AnnouncementsProvider';
import { NoticeItem } from './NoticeItem';

/** Notices shown at first, and added per "Show more". */
const STEP = 5;
/** How long a deep-linked notice glows after it lands. */
const HIGHLIGHT_MS = 1600;

/**
 * The dashboard's noticeboard — where announcements are READ.
 *
 * Pinned notices lead (with a gold edge), then everything else newest first.
 * The bell and the old Announcements page both hand over here: `focus` is the
 * parsed `?notice=` param, and once it has been acted on `onFocusHandled`
 * lets the page drop it from the URL.
 *
 * Reading here does NOT mark anything seen (owner decision) — only opening the
 * bell moves the watermark. The "New" markers therefore mean exactly what the
 * bell's dots mean.
 */
export function AnnouncementsSection({
  focus,
  onFocusHandled,
  className,
}: {
  focus: NoticeFocus | null;
  onFocusHandled: () => void;
  className?: string;
}) {
  const { state, loadMore, retry, injectNotice } = useAnnouncements();
  const [visible, setVisible] = useState(STEP);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [highlight, setHighlight] = useState<string | null>(null);
  /** A deep-linked notice waiting to be expanded, revealed and scrolled to. */
  const [target, setTarget] = useState<string | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const list = useMemo(() => sectionItems(state.pinned, state.items), [state.pinned, state.items]);
  const shown = list.slice(0, visible);
  const newCount = list.filter((notice) => notice.isNew).length;
  const now = new Date();

  const reducedMotion = (): boolean =>
    typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const focusHeading = useCallback((): void => {
    const node = heading.current;
    if (node === null) return;
    // Scroll the whole CARD clear of the sticky topbar (its scroll-mt), then
    // hand focus to the heading without a second jump.
    (node.closest('section') ?? node).scrollIntoView({
      behavior: reducedMotion() ? 'auto' : 'smooth',
      block: 'start',
    });
    node.focus({ preventScroll: true });
  }, []);

  // Step 1 — resolve the param once the feed is on screen.
  useEffect(() => {
    if (focus === null || state.status !== 'ready') return;
    if (focus === 'all') {
      focusHeading();
      onFocusHandled();
      return;
    }
    if (list.some((notice) => notice.id === focus.id)) {
      setTarget(focus.id);
      return;
    }
    // Beyond the loaded pages: fetch it by id and fold it into the feed.
    let cancelled = false;
    fetchAnnouncement(focus.id)
      .then((notice) => {
        if (cancelled) return;
        injectNotice(notice);
        setTarget(notice.id);
      })
      .catch(() => {
        if (cancelled) return;
        toast('That announcement is no longer available');
        focusHeading();
        onFocusHandled();
      });
    return () => {
      cancelled = true;
    };
    // `list` is deliberately not a dependency: this resolves the PARAM, once;
    // step 2 watches the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, state.status]);

  // Step 2 — make the target renderable: expanded, and inside the shown slice.
  const targetIndex = target === null ? -1 : list.findIndex((notice) => notice.id === target);
  useEffect(() => {
    if (target === null || targetIndex === -1) return;
    setExpanded((prev) => (prev.has(target) ? prev : new Set(prev).add(target)));
    setVisible((prev) => Math.max(prev, targetIndex + 1));
  }, [target, targetIndex]);

  // Step 3 — once it is on screen: scroll, focus, glow, and clear the URL.
  const targetReady =
    target !== null && targetIndex !== -1 && targetIndex < visible && expanded.has(target);
  useEffect(() => {
    if (!targetReady || target === null) return;
    const article = document.getElementById(noticeDomId(target));
    if (article !== null) {
      article.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
      article.querySelector<HTMLButtonElement>('h3 button')?.focus({ preventScroll: true });
    }
    setHighlight(target);
    setTarget(null);
    onFocusHandled();
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetReady]);

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const showMore = (): void => {
    const next = visible + STEP;
    setVisible(next);
    if (next > list.length && canLoadMore(state)) void loadMore();
  };

  const total = Math.max(state.total, list.length);
  const moreAvailable = visible < list.length || canLoadMore(state);

  return (
    <section
      aria-labelledby="dash-notices"
      className={cn('p-card scroll-mt-20 overflow-hidden', className)}
    >
      <CardHead
        as="h2"
        id="dash-notices"
        headingRef={heading}
        title="Announcements"
        action={
          newCount > 0 ? (
            <span className="rounded-full bg-warn-bg px-2.5 py-1 font-display text-[10.5px] font-semibold uppercase tracking-[0.1em] text-warn">
              {newCount} new
            </span>
          ) : null
        }
      />

      {state.status === 'idle' || state.status === 'loading' ? (
        <SectionSkeleton />
      ) : state.status === 'error' && list.length === 0 ? (
        <EmptyState
          title="Couldn't load announcements"
          hint="Check your connection, then try again."
          action={
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={retry}>
              Try again
            </button>
          }
        />
      ) : list.length === 0 ? (
        <EmptyState
          title="No announcements yet"
          hint="Closures, schedule changes and events from the gym will show up here."
          action={
            <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={retry}>
              Check again
            </button>
          }
        />
      ) : (
        <>
          <div>
            {shown.map((notice) => (
              <NoticeItem
                key={notice.id}
                notice={notice}
                open={expanded.has(notice.id)}
                highlighted={highlight === notice.id}
                now={now}
                onToggle={() => toggle(notice.id)}
              />
            ))}
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-[18px] py-3">
            <p role="status" className="m-0 text-[12.5px] text-muted-foreground">
              Showing {Math.min(visible, list.length)} of {total} announcements
            </p>
            {moreAvailable ? (
              <button
                type="button"
                onClick={showMore}
                disabled={state.loadingMore}
                className="p-btn p-btn-ghost p-btn-sm"
              >
                {state.loadingMore ? 'Loading…' : 'Show more'}
              </button>
            ) : null}
          </div>
        </>
      )}
    </section>
  );
}

function SectionSkeleton() {
  return (
    <div aria-hidden>
      {[0, 1, 2].map((row) => (
        <div
          key={row}
          className="grid gap-2.5 border-b border-border px-[18px] py-4 last:border-b-0"
        >
          <span className="h-4 w-2/3 animate-pulse rounded bg-secondary" />
          <span className="h-3 w-1/3 animate-pulse rounded bg-muted" />
          <span className="h-3 w-full animate-pulse rounded bg-muted" />
        </div>
      ))}
    </div>
  );
}
