'use client';

import type { MemberAnnouncement } from '@got/shared';
import { noticeDomId } from '@/lib/announcements/focus';
import { previewText } from '@/lib/announcements/preview';
import { absoluteTime, relativeTime } from '@/lib/announcements/time';
import { cn } from '@/lib/utils';
import { NewMarker } from './NewMarker';
import { NoticeCover, RichContent } from './RichContent';

/**
 * One notice on the dashboard — a disclosure, not a link.
 *
 * The `<h3>` wraps the button that expands it (`aria-expanded` +
 * `aria-controls`), so the section's heading list reads as the list of
 * notices and each one is operable from the keyboard. Collapsed, it shows the
 * title, "New", the author, the time and two lines of preview; expanded, the
 * full text. Several can be open at once.
 *
 * The body: a rich notice (`contentJson`) renders through `RichContent` —
 * Tiptap's static renderer to React elements, never HTML — with its cover
 * image above it. A plain notice (every one posted before rich text, and
 * anything written through the plain `content` route) stays exactly as it
 * was: plain text with `white-space: pre-wrap`, no linkify. The collapsed
 * preview reads the derived plain `content` in both cases.
 */
export function NoticeItem({
  notice,
  open,
  highlighted,
  now,
  onToggle,
}: {
  notice: MemberAnnouncement;
  open: boolean;
  highlighted: boolean;
  now: Date;
  onToggle: () => void;
}) {
  const domId = noticeDomId(notice.id);
  const bodyId = `${domId}-body`;
  const author = `${notice.author.firstName} ${notice.author.lastName}`.trim();

  return (
    <article
      id={domId}
      aria-labelledby={`${domId}-title`}
      data-highlighted={highlighted || undefined}
      className={cn(
        'relative scroll-mt-20 border-b border-border px-[18px] py-4 transition-colors duration-700 last:border-b-0',
        'data-[highlighted]:bg-accent data-[highlighted]:duration-150',
        notice.isPinned &&
          "before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-gold before:content-['']",
      )}
    >
      <h3 className="m-0 font-display text-[15px] leading-snug font-semibold">
        <button
          type="button"
          id={`${domId}-title`}
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="group -mx-2 -my-1.5 flex min-h-11 w-[calc(100%+1rem)] cursor-pointer items-start justify-between gap-3 rounded-md px-2 py-1.5 text-left text-foreground transition-[color,background-color,border-color] hover:text-gold-deep focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-gold"
        >
          <span className="min-w-0 pt-px [overflow-wrap:anywhere]">{notice.title}</span>
          <svg
            aria-hidden
            viewBox="0 0 24 24"
            className={cn(
              'mt-0.5 size-[18px] shrink-0 fill-none stroke-current stroke-2 text-muted-foreground transition-transform duration-200 group-hover:text-gold-deep',
              open && 'rotate-180',
            )}
          >
            <path d="M6 9l6 6 6-6" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </h3>

      <p className="m-0 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-muted-foreground">
        {notice.isNew ? <NewMarker /> : null}
        {notice.isPinned ? (
          <span className="font-display text-[10.5px] font-semibold uppercase tracking-[0.12em] text-gold-deep">
            Pinned
          </span>
        ) : null}
        {author !== '' ? <span>{author}</span> : null}
        <span aria-hidden>·</span>
        <time dateTime={notice.createdAt} title={absoluteTime(notice.createdAt)}>
          {relativeTime(notice.createdAt, now)}
        </time>
      </p>

      {open ? null : (
        // The preview repeats the body's first lines — hidden from screen
        // readers, who get the full text by expanding.
        <p
          aria-hidden
          onClick={onToggle}
          className="m-0 mt-2 line-clamp-2 cursor-pointer text-[13.5px] leading-relaxed text-ink-2"
        >
          {previewText(notice.content, 280)}
        </p>
      )}

      <div
        id={bodyId}
        hidden={!open}
        className="mt-3 max-w-prose text-[14.5px] leading-relaxed text-ink-2 [overflow-wrap:anywhere]"
      >
        {/* The cover and the rich body mount only while open, so a collapsed
            notice never fetches its images; collapsed, the body is its plain
            text, still in the DOM for aria-controls. */}
        {open ? <NoticeCover url={notice.coverImageUrl} className="mb-3" /> : null}
        {open && notice.contentJson !== null ? (
          <RichContent doc={notice.contentJson} fallback={notice.content} />
        ) : (
          <div className="whitespace-pre-wrap">{notice.content}</div>
        )}
      </div>
    </article>
  );
}
