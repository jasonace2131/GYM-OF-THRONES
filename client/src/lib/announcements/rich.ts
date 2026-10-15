import {
  announcementDocToPlainText,
  announcementImageBaseUrl,
  isAllowedLinkHref,
  isAnnouncementImageUrl,
  type AnnouncementDoc,
  type AnnouncementDocNode,
} from '@got/shared';

/**
 * The decisions behind rich-text notices, kept out of the components.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SERVER'S ALLOWLIST IS THE GATE; THIS IS THE SECOND LOCK.
 *
 * Every document reached the database through `sanitizeAnnouncementDoc`, so a
 * `javascript:` link or a hotlinked image should never arrive here. The
 * renderer re-checks anyway, with the same shared rules, and fails CLOSED: a
 * link that does not pass renders as its text, an image that does not pass
 * renders as nothing. A tampered row, a restored backup, or a future bug in
 * the API cannot turn a notice into a script on every member's phone.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Where this deployment's announcement images live. Baked in at build time. */
export function clientImageBase(): string {
  return announcementImageBaseUrl(process.env.NEXT_PUBLIC_SUPABASE_URL ?? '');
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The attributes an `<a>` gets, or null to render the text unlinked.
 *
 * A new tab, and `noopener noreferrer` so the page it opens can neither
 * reach back into this one nor learn which member clicked. `nofollow`
 * because a notice is not an endorsement.
 */
export function linkAttributes(
  href: unknown,
): { href: string; rel: string; target: string } | null {
  if (!isAllowedLinkHref(href)) return null;
  return { href, rel: 'noopener noreferrer nofollow', target: '_blank' };
}

const dimension = (value: unknown): number | undefined =>
  Number.isInteger(value) && (value as number) > 0 && (value as number) <= 20_000
    ? (value as number)
    : undefined;

/**
 * The attributes an `<img>` gets, or null to render nothing.
 *
 * Only images this project minted in its own public bucket. Width and height
 * travel when known, so the browser reserves the space before the image
 * arrives and the notice does not jump under a member's thumb.
 */
export function imageAttributes(
  attrs: unknown,
  base: string,
): { src: string; alt: string; width?: number; height?: number } | null {
  if (!isRecord(attrs)) return null;
  const src = attrs['src'];
  if (!isAnnouncementImageUrl(src, base)) return null;

  const width = dimension(attrs['width']);
  const height = dimension(attrs['height']);
  return {
    src,
    alt: typeof attrs['alt'] === 'string' ? attrs['alt'] : '',
    ...(width === undefined ? {} : { width }),
    ...(height === undefined ? {} : { height }),
  };
}

type HeadingTag = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

/**
 * The element a document heading renders as.
 *
 * A notice's own title is already a heading on every surface, so the body's
 * "H2" sits BELOW it — `base` is the level the body's H2 becomes. Keeps the
 * page's heading outline, which is how screen-reader users skim the board.
 */
export function headingTag(level: unknown, base: number): HeadingTag {
  const offset = level === 3 ? 1 : 0;
  return `h${Math.min(6, Math.max(2, base + offset))}` as HeadingTag;
}

/**
 * An old plain-text notice as a document the editor can open.
 *
 * Blank lines become paragraphs and single newlines hard breaks — which is
 * exactly how `announcementDocToPlainText` reads them back, so opening an old
 * notice and saving it unchanged stores the same text.
 */
export function plainTextToDoc(text: string): AnnouncementDoc {
  const paragraphs = text
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .filter((paragraph) => paragraph.trim() !== '');

  if (paragraphs.length === 0) return { type: 'doc', content: [{ type: 'paragraph' }] };

  return {
    type: 'doc',
    content: paragraphs.map((paragraph) => {
      const content: AnnouncementDocNode[] = [];
      paragraph.split('\n').forEach((line, index) => {
        if (index > 0) content.push({ type: 'hardBreak' });
        if (line !== '') content.push({ type: 'text', text: line });
      });
      return { type: 'paragraph', content };
    }),
  };
}

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const EMAIL = /^[^\s@/:]+@[^\s@/:]+\.[^\s@/:]+$/;
const DOMAIN = /^[^\s/:@]+\.[^\s/:@]+(?:[/?#]\S*)?$/;

/**
 * What an admin typed into the link box, as an href the server will accept —
 * or null, and the box says so before anything is sent.
 *
 * Forgiving about what people actually type ("gymofthrones.ph", a bare email
 * address) and strict about everything else: once a scheme is present it must
 * be one the shared rule allows.
 */
export function normalizeLinkInput(raw: string): string | null {
  const text = raw.trim();
  if (text === '') return null;

  let href: string;
  if (HAS_SCHEME.test(text)) href = text;
  else if (EMAIL.test(text)) href = `mailto:${text}`;
  else if (DOMAIN.test(text)) href = `https://${text}`;
  else return null;

  return isAllowedLinkHref(href) ? href : null;
}

/** The length the server will measure — code points of the derived text. */
export function derivedLength(doc: AnnouncementDoc): number {
  return [...announcementDocToPlainText(doc)].length;
}

/**
 * Roving focus for the editor's toolbar (WAI-ARIA toolbar pattern): arrows
 * move between buttons, Home and End jump to the ends, Tab leaves the toolbar
 * entirely. Null means "not ours — let the browser have it".
 */
export function nextToolbarIndex(current: number, key: string, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      return (current + 1) % count;
    case 'ArrowLeft':
    case 'ArrowUp':
      return (current - 1 + count) % count;
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    default:
      return null;
  }
}
