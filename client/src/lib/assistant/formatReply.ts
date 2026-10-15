/**
 * An assistant reply, split into blocks the chat can lay out.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TEXT IN, TEXT OUT — NEVER MARKUP.
 *
 * The reply is model output, which is untrusted. Everything here returns plain
 * strings, and the page renders them as React text children, so a model that
 * writes `<img onerror=…>` produces those characters on screen and nothing
 * more. No HTML is built and nothing reaches `dangerouslySetInnerHTML`.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The system prompt asks for plain text in a fixed shape — day headings on
 * their own line ending in ":", exercises on "- " lines, a blank line between
 * days — and that is the shape this reads best. A model does not always
 * comply, so the markdown it most often sends anyway (#-headings, bold, `*`
 * bullets, numbered lists, rules, fences, links) is tolerated and flattened
 * rather than shown as literal asterisks.
 */
export type ReplyBlock =
  | { kind: 'heading'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] }
  | { kind: 'paragraph'; text: string };

const FENCE = /^\s*(```|~~~)/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const HASH_HEADING = /^\s*#{1,6}\s+(.*)$/;
// Wrapped ENTIRELY in bold: no `**` inside, so "**Mon** and **Fri**" is not one.
const BOLD_HEADING = /^\s*(?:\*\*([^*]+)\*\*|__([^_]+)__)\s*:?\s*$/;
const BULLET = /^\s*[-*•]\s+(.*)$/;
const ORDERED = /^\s*\d{1,3}[.)]\s+(.*)$/;
const CONTINUATION = /^\s{2,}\S/;
const SHORT_HEADING_MAX = 60;

/** Inline markdown reduced to its words. */
function stripInline(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\([^)\s]*\)/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/\*(\S(?:[^*]*\S)?)\*/g, '$1')
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .trim();
}

function headingText(text: string): string {
  return stripInline(text).replace(/\s*:\s*$/, '');
}

export function formatReply(raw: string): ReplyBlock[] {
  const blocks: ReplyBlock[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flush = (): void => {
    if (paragraph.length > 0) {
      blocks.push({ kind: 'paragraph', text: paragraph.join('\n') });
      paragraph = [];
    }
    if (list !== null) {
      if (list.items.length > 0) blocks.push({ kind: 'list', ...list });
      list = null;
    }
  };

  const heading = (text: string): void => {
    flush();
    if (text !== '') blocks.push({ kind: 'heading', text });
  };

  for (const line of raw.replace(/\r\n?/g, '\n').split('\n')) {
    // The fence markers go; whatever was between them stays as ordinary text.
    if (FENCE.test(line)) continue;

    if (line.trim() === '' || RULE.test(line)) {
      flush();
      continue;
    }

    const hash = HASH_HEADING.exec(line);
    if (hash !== null) {
      heading(headingText(hash[1] ?? ''));
      continue;
    }

    const bold = BOLD_HEADING.exec(line);
    if (bold !== null) {
      heading(headingText(bold[1] ?? bold[2] ?? ''));
      continue;
    }

    const bullet = BULLET.exec(line);
    const numbered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || numbered !== null) {
      const ordered = bullet === null;
      const item = stripInline((bullet ?? numbered)?.[1] ?? '');
      if (list === null || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      if (item !== '') list.items.push(item);
      continue;
    }

    const text = stripInline(line);

    if (text.length <= SHORT_HEADING_MAX && text.endsWith(':')) {
      heading(headingText(text));
      continue;
    }

    if (list !== null) {
      const last = list.items.length - 1;
      if (CONTINUATION.test(line) && last >= 0) {
        list.items[last] = `${list.items[last]} ${text}`;
        continue;
      }
      flush();
    }

    if (text !== '') paragraph.push(text);
  }

  flush();
  return blocks;
}
