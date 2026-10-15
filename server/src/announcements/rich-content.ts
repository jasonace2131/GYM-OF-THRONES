import {
  ANNOUNCEMENT_CONTENT_MAX,
  ANNOUNCEMENT_DOC_MAX_BYTES,
  ANNOUNCEMENT_HEADING_LEVELS,
  announcementDocToPlainText,
  isAllowedLinkHref,
  isAnnouncementImageUrl,
  type AnnouncementDoc,
  type AnnouncementDocMark,
  type AnnouncementDocNode,
} from '@got/shared';

/**
 * The server's gate on a rich-text notice.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * REBUILT, NOT CHECKED-AND-PASSED-THROUGH.
 *
 * `sanitizeAnnouncementDoc` never returns the object it was given. It walks
 * the input and constructs a new document from the allowlist, copying only
 * the attributes this file names. An attribute nobody thought to forbid —
 * `onerror`, `style`, `srcset`, a future Tiptap attr — therefore cannot reach
 * the database, because nothing copies it. What is REFUSED (a 400) is what
 * would change the meaning of the notice if silently dropped: an unknown node
 * or mark, a link or image URL outside the rules, a heading level we do not
 * render, and structure ProseMirror itself could not load.
 *
 * BOUNDED BEFORE IT IS WALKED. Depth and node count are checked on the way
 * down, so a 100,000-deep or 100,000-wide payload is refused after at most
 * `RICH_MAX_DEPTH` frames and `RICH_MAX_NODES` visits — never a stack
 * overflow, which Nest would report as a bare 500.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export {
  ANNOUNCEMENT_CONTENT_MAX,
  ANNOUNCEMENT_DOC_MAX_BYTES,
  announcementDocToPlainText,
  announcementImageBaseUrl,
  announcementImageKey,
  isAllowedLinkHref,
  isAnnouncementImageUrl,
} from '@got/shared';
export type { AnnouncementDoc } from '@got/shared';

/** Nesting ceiling. Seven levels of nested list fit; a depth bomb does not. */
export const RICH_MAX_DEPTH = 16;

/** Node ceiling — far past any real notice, and it bounds the walk. */
export const RICH_MAX_NODES = 5000;

/** `alt` text is for a sentence, not an essay. */
const ALT_MAX = 300;
/** Larger than any image the console produces (it resizes to 1600 wide). */
const DIMENSION_MAX = 20_000;
const ORDERED_START_MAX = 10_000;

export interface RichContentRules {
  /** `announcementImageBaseUrl(SUPABASE_URL)` — where every image must live. */
  imageBaseUrl: string;
}

export type SanitizeResult =
  { ok: true; doc: AnnouncementDoc; text: string } | { ok: false; reason: string };

/** Where a node sits decides which node types may appear there. */
type Slot = 'block' | 'inline' | 'listItem';

const BLOCK_TYPES = new Set([
  'paragraph',
  'heading',
  'bulletList',
  'orderedList',
  'blockquote',
  'horizontalRule',
  'image',
]);
const INLINE_TYPES = new Set(['text', 'hardBreak']);

class Refusal extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A type name, cut short before it is echoed back in an error message. */
const named = (value: unknown): string =>
  typeof value === 'string' ? JSON.stringify(value.slice(0, 40)) : 'a node with no type';

export function sanitizeAnnouncementDoc(input: unknown, rules: RichContentRules): SanitizeResult {
  try {
    if (!isRecord(input) || input['type'] !== 'doc') {
      throw new Refusal('The message must be a document.');
    }

    const budget = { nodes: 1 };
    const content = children(input['content'], 'block', 1, rules, budget, true);
    const doc: AnnouncementDoc = { type: 'doc', content };

    const bytes = Buffer.byteLength(JSON.stringify(doc), 'utf8');
    if (bytes > ANNOUNCEMENT_DOC_MAX_BYTES) {
      throw new Refusal(
        `The message is too large (${Math.ceil(bytes / 1024)} KB; the limit is ${ANNOUNCEMENT_DOC_MAX_BYTES / 1024} KB).`,
      );
    }

    const text = announcementDocToPlainText(doc);
    if (text === '') {
      throw new Refusal('Write some text as well — the bell and previews show it.');
    }
    // Code points, as Postgres's char_length counts them — an emoji is one.
    if ([...text].length > ANNOUNCEMENT_CONTENT_MAX) {
      throw new Refusal(
        `The message's text is over ${ANNOUNCEMENT_CONTENT_MAX.toLocaleString('en-US')} characters.`,
      );
    }

    return { ok: true, doc, text };
  } catch (caught) {
    if (caught instanceof Refusal) return { ok: false, reason: caught.message };
    throw caught;
  }
}

function children(
  value: unknown,
  slot: Slot,
  depth: number,
  rules: RichContentRules,
  budget: { nodes: number },
  required: boolean,
): AnnouncementDocNode[] {
  if (value === undefined && !required) return [];
  if (!Array.isArray(value)) throw new Refusal('Content must be a list of nodes.');
  if (required && value.length === 0)
    throw new Refusal('A list, list item or quote cannot be empty.');

  // Counted BEFORE any child is visited, so a very wide payload is refused
  // without walking it.
  budget.nodes += value.length;
  if (budget.nodes > RICH_MAX_NODES) {
    throw new Refusal('The message is too large (too many elements).');
  }

  return value.map((child) => node(child, slot, depth, rules, budget));
}

function node(
  value: unknown,
  slot: Slot,
  depth: number,
  rules: RichContentRules,
  budget: { nodes: number },
): AnnouncementDocNode {
  if (depth > RICH_MAX_DEPTH) throw new Refusal('The message is nested too deeply.');
  if (!isRecord(value)) throw new Refusal('Every part of the message must be a node.');

  const type = value['type'];
  const attrs = isRecord(value['attrs']) ? value['attrs'] : {};

  const fits =
    slot === 'listItem'
      ? type === 'listItem'
      : slot === 'inline'
        ? typeof type === 'string' && INLINE_TYPES.has(type)
        : typeof type === 'string' && BLOCK_TYPES.has(type);

  if (!fits) {
    const known =
      typeof type === 'string' &&
      (BLOCK_TYPES.has(type) || INLINE_TYPES.has(type) || type === 'listItem');
    throw new Refusal(
      known
        ? `${named(type)} is not allowed there.`
        : `${named(type)} is not allowed in an announcement (unsupported content).`,
    );
  }

  const next = depth + 1;

  switch (type) {
    case 'paragraph':
      return withContent(
        { type },
        children(value['content'], 'inline', next, rules, budget, false),
      );

    case 'heading': {
      const level = attrs['level'];
      if (!(ANNOUNCEMENT_HEADING_LEVELS as readonly unknown[]).includes(level)) {
        throw new Refusal('Headings can be level 2 or 3 only.');
      }
      return withContent(
        { type, attrs: { level: level as number } },
        children(value['content'], 'inline', next, rules, budget, false),
      );
    }

    case 'bulletList':
      return { type, content: children(value['content'], 'listItem', next, rules, budget, true) };

    case 'orderedList': {
      const start = attrs['start'];
      const safeStart =
        Number.isInteger(start) && (start as number) >= 1 && (start as number) <= ORDERED_START_MAX
          ? (start as number)
          : 1;
      return {
        type,
        attrs: { start: safeStart },
        content: children(value['content'], 'listItem', next, rules, budget, true),
      };
    }

    case 'listItem':
    case 'blockquote':
      return { type, content: children(value['content'], 'block', next, rules, budget, true) };

    case 'horizontalRule':
    case 'hardBreak':
      return { type };

    case 'image':
      return image(attrs, rules);

    case 'text':
      return text(value);

    // Unreachable: `fits` admitted only the types above.
    default:
      throw new Refusal(`${named(type)} is not allowed in an announcement.`);
  }
}

function withContent(
  base: AnnouncementDocNode,
  content: AnnouncementDocNode[],
): AnnouncementDocNode {
  return content.length === 0 ? base : { ...base, content };
}

function image(attrs: Record<string, unknown>, rules: RichContentRules): AnnouncementDocNode {
  const src = attrs['src'];
  if (!isAnnouncementImageUrl(src, rules.imageBaseUrl)) {
    throw new Refusal('Images must be uploaded here — an image from anywhere else is refused.');
  }

  const out: Record<string, string | number> = { src };
  const alt = attrs['alt'];
  if (typeof alt === 'string' && alt.trim() !== '') out['alt'] = alt.trim().slice(0, ALT_MAX);
  for (const key of ['width', 'height'] as const) {
    const n = attrs[key];
    if (Number.isInteger(n) && (n as number) > 0 && (n as number) <= DIMENSION_MAX) {
      out[key] = n as number;
    }
  }
  return { type: 'image', attrs: out };
}

function text(value: Record<string, unknown>): AnnouncementDocNode {
  const content = value['text'];
  if (typeof content !== 'string' || content === '') {
    throw new Refusal('A text node must have text.');
  }

  const out: AnnouncementDocNode = { type: 'text', text: content };
  const rawMarks = value['marks'];
  if (rawMarks === undefined) return out;
  if (!Array.isArray(rawMarks)) throw new Refusal('Text formatting must be a list.');
  if (rawMarks.length > 8) throw new Refusal('Too much formatting on one run of text.');

  const marks: AnnouncementDocMark[] = [];
  const seen = new Set<string>();
  for (const raw of rawMarks) {
    const mark = markOf(raw);
    if (seen.has(mark.type)) continue;
    seen.add(mark.type);
    marks.push(mark);
  }
  return marks.length === 0 ? out : { ...out, marks };
}

function markOf(raw: unknown): AnnouncementDocMark {
  if (!isRecord(raw)) throw new Refusal('Text formatting must be a list of marks.');
  const type = raw['type'];

  if (type === 'bold' || type === 'italic') return { type };

  if (type === 'link') {
    const href = isRecord(raw['attrs']) ? raw['attrs']['href'] : undefined;
    if (!isAllowedLinkHref(href)) {
      throw new Refusal('Links must start with http://, https:// or mailto:.');
    }
    return { type, attrs: { href } };
  }

  throw new Refusal(`${named(type)} formatting is not allowed (unsupported mark).`);
}

// ── Reading stored documents ───────────────────────────────────────────────

/**
 * Every image `src` in a stored document, for the orphan cleanup job.
 *
 * Tolerant rather than strict: it reads rows already in the database, and a
 * row it cannot understand must yield "no images" rather than an exception
 * that stops the job from protecting everybody else's. Iterative and bounded,
 * so it holds even for JSON that bypassed the sanitiser.
 */
export function collectAnnouncementImageUrls(stored: unknown): string[] {
  const urls: string[] = [];
  const stack: Array<{ value: unknown; depth: number }> = [{ value: stored, depth: 0 }];
  let visited = 0;

  while (stack.length > 0 && visited < RICH_MAX_NODES * 4) {
    const { value, depth } = stack.pop() as { value: unknown; depth: number };
    visited += 1;
    if (!isRecord(value) || depth > RICH_MAX_DEPTH * 2) continue;

    if (value['type'] === 'image' && isRecord(value['attrs'])) {
      const src = value['attrs']['src'];
      if (typeof src === 'string') urls.push(src);
    }
    const content = value['content'];
    if (Array.isArray(content)) {
      for (const child of content) stack.push({ value: child, depth: depth + 1 });
    }
  }
  return urls;
}
