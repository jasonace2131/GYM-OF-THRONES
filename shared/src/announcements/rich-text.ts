/**
 * Rich-text announcements: the rules the server enforces and the console
 * follows, defined once and run in both places.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SERVER IS THE AUTHORITY; THIS FILE IS WHAT KEEPS THE CLIENT HONEST.
 *
 * A notice body is ProseMirror JSON (Tiptap's own format), stored in
 * `Announcement.contentJson` only after `sanitizeAnnouncementDoc` on the server
 * has rebuilt it from an allowlist. The console imports the same URL rules and
 * the same plain-text derivation so its link box refuses what the server
 * refuses and its character counter counts what the server stores — without
 * that, the counter would say "12 left" about a notice the API then rejects.
 *
 * Pure and dependency-free on purpose: no `URL`, no `Buffer`, no DOM. This
 * package compiles against plain ES2020, and a rule that needed a runtime
 * global would behave differently in the two places it runs.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Every node type a stored notice may contain. Anything else is a 400. */
export const ANNOUNCEMENT_NODE_TYPES = [
  'doc',
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'listItem',
  'blockquote',
  'hardBreak',
  'horizontalRule',
  'image',
  'text',
] as const;
export type AnnouncementNodeType = (typeof ANNOUNCEMENT_NODE_TYPES)[number];

/** Every mark a stored notice may carry. No code, no strike, no colours. */
export const ANNOUNCEMENT_MARK_TYPES = ['bold', 'italic', 'link'] as const;
export type AnnouncementMarkType = (typeof ANNOUNCEMENT_MARK_TYPES)[number];

/** H1 is the page's own title; a notice starts at H2. */
export const ANNOUNCEMENT_HEADING_LEVELS = [2, 3] as const;

/**
 * The derived plain text's ceiling — `Announcement_content_sane` in SQL
 * (`char_length(btrim(content)) BETWEEN 1 AND 4000`), counted in code points
 * exactly as Postgres counts them.
 */
export const ANNOUNCEMENT_CONTENT_MAX = 4000;

/** The sanitised JSON's ceiling, in UTF-8 bytes. */
export const ANNOUNCEMENT_DOC_MAX_BYTES = 64 * 1024;

/** Any URL we store — a link or an image. */
export const ANNOUNCEMENT_URL_MAX = 2048;

// ── Images ─────────────────────────────────────────────────────────────────

/** The PUBLIC Supabase bucket announcement images live in. */
export const ANNOUNCEMENT_IMAGE_BUCKET = 'announcements';

/** The folder inside that bucket every object this server mints goes under. */
export const ANNOUNCEMENT_IMAGE_PREFIX = 'announcements';

/** No SVG, ever: an SVG is a document that can carry script. */
export const ANNOUNCEMENT_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type AnnouncementImageType = (typeof ANNOUNCEMENT_IMAGE_TYPES)[number];

/** The bucket's own `fileSizeLimit`. The browser resizes well under it first. */
export const ANNOUNCEMENT_IMAGE_MAX_BYTES = 5 * 1024 * 1024;

// ── The stored shape ───────────────────────────────────────────────────────

export interface AnnouncementDocMark {
  type: AnnouncementMarkType;
  /** Present on `link` only, and then only `href`. */
  attrs?: { href: string };
}

/**
 * One node as STORED — i.e. after the server's allowlist rebuilt it. The only
 * attributes that survive are `heading.level`, `orderedList.start` and
 * `image.{src, alt, width, height}`.
 */
export interface AnnouncementDocNode {
  type: AnnouncementNodeType;
  attrs?: Record<string, string | number>;
  content?: AnnouncementDocNode[];
  marks?: AnnouncementDocMark[];
  text?: string;
}

export interface AnnouncementDoc {
  type: 'doc';
  content: AnnouncementDocNode[];
}

// ── URL rules ──────────────────────────────────────────────────────────────

/**
 * Whitespace and control characters, anywhere.
 *
 * This is the whole defence against scheme smuggling. A browser strips leading
 * C0 controls and spaces from a URL and deletes tabs and newlines from inside
 * it, so `" javascript:…"` and `"java\tscript:…"` both RUN as `javascript:`.
 * A string with none of those characters has exactly the scheme it starts with.
 */
// eslint-disable-next-line no-control-regex
const UNSAFE_URL_CHARACTER = /[\s\u0000-\u001f\u007f-\u009f\\]/;

const WEB_LINK = /^https?:\/\/[^/?#]/i;
const MAIL_LINK = /^mailto:[^/?#]/i;

/**
 * `http:`, `https:` and `mailto:` — nothing else, and never relative.
 *
 * A prefix test on a string with no whitespace or control characters in it
 * (see above), which is stricter than parsing: `new URL()` would happily
 * normalise a hostile string into an allowed one.
 */
export function isAllowedLinkHref(href: unknown): href is string {
  if (typeof href !== 'string') return false;
  if (href.length === 0 || href.length > ANNOUNCEMENT_URL_MAX) return false;
  if (UNSAFE_URL_CHARACTER.test(href)) return false;
  return WEB_LINK.test(href) || MAIL_LINK.test(href);
}

/**
 * The public URL prefix of the announcements bucket:
 * `<SUPABASE_URL>/storage/v1/object/public/announcements/`.
 */
export function announcementImageBaseUrl(supabaseUrl: string): string {
  return `${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/public/${ANNOUNCEMENT_IMAGE_BUCKET}/`;
}

/**
 * The object keys this server mints, and nothing else:
 * `announcements/<uuid>.<webp|jpg|png>`.
 *
 * Matching the exact minted shape rather than "anything under the bucket"
 * closes traversal (`../`, `%2e%2e/`), query strings, fragments and every
 * extension the bucket was never meant to hold — in one regex, with no URL
 * normalisation to reason about.
 */
const IMAGE_KEY = new RegExp(
  `^${ANNOUNCEMENT_IMAGE_PREFIX}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\.(?:webp|jpg|png)$`,
);

/**
 * True when `url` is an image this server minted in the announcements bucket.
 * Always false when the bucket itself is not served over https — the
 * `Announcement_coverImageUrl_https` CHECK would refuse it anyway.
 */
export function isAnnouncementImageUrl(url: unknown, baseUrl: string): url is string {
  if (typeof url !== 'string' || url.length > ANNOUNCEMENT_URL_MAX) return false;
  if (!baseUrl.startsWith('https://') || !url.startsWith(baseUrl)) return false;
  return IMAGE_KEY.test(url.slice(baseUrl.length));
}

/** The object key inside the bucket, or null when `url` is not one of ours. */
export function announcementImageKey(url: string, baseUrl: string): string | null {
  return isAnnouncementImageUrl(url, baseUrl) ? url.slice(baseUrl.length) : null;
}

// ── Plain text ─────────────────────────────────────────────────────────────

/**
 * The notice as plain text — what `Announcement.content` stores for a rich
 * notice, and so what the bell, the pinned banner and every preview read.
 *
 * Blocks are separated by a blank line, list items by a newline with a "• " or
 * "3. " prefix, a hard break is a newline, and images and rules contribute
 * nothing. Trimmed, because the SQL CHECK measures the trimmed length.
 *
 * Expects a SANITISED document: the recursion here is bounded only because
 * the server's allowlist already refused anything nested too deeply.
 */
export function announcementDocToPlainText(doc: AnnouncementDoc): string {
  return blocksText(doc.content ?? [], '\n\n').trim();
}

function blocksText(nodes: readonly AnnouncementDocNode[], separator: string): string {
  return nodes
    .map(blockText)
    .filter((text) => text.trim() !== '')
    .join(separator);
}

function blockText(node: AnnouncementDocNode): string {
  switch (node.type) {
    case 'paragraph':
    case 'heading':
      return inlineText(node.content ?? []);
    case 'blockquote':
      return blocksText(node.content ?? [], '\n\n');
    case 'listItem':
      return blocksText(node.content ?? [], '\n');
    case 'bulletList':
      return (node.content ?? []).map((item) => `• ${blockText(item)}`).join('\n');
    case 'orderedList': {
      const start = typeof node.attrs?.['start'] === 'number' ? node.attrs['start'] : 1;
      return (node.content ?? []).map((item, i) => `${start + i}. ${blockText(item)}`).join('\n');
    }
    default:
      // image, horizontalRule — nothing to read aloud in a one-line preview.
      return '';
  }
}

function inlineText(nodes: readonly AnnouncementDocNode[]): string {
  let text = '';
  for (const node of nodes) {
    if (node.type === 'text') text += node.text ?? '';
    else if (node.type === 'hardBreak') text += '\n';
  }
  return text;
}
