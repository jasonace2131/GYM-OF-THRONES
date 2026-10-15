/**
 * One line of a notice, for the bell's rows.
 *
 * Whitespace is collapsed first — the composer is a plain textarea, so a
 * notice's paragraphs arrive as newlines — then the text is cut at the last
 * word boundary under `max`, with any trailing punctuation dropped so a
 * preview never ends ",…". A single word longer than `max` is hard-cut
 * rather than returned whole.
 */
export function previewText(content: string, max: number): string {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;

  const head = text.slice(0, max);
  // A cut that lands exactly at the end of a word keeps that word.
  const boundary = text[max] === ' ' ? max : head.lastIndexOf(' ');
  const cut = boundary > 0 ? head.slice(0, boundary) : head;
  return `${cut.replace(/[\s,.;:!?\-–—]+$/u, '')}…`;
}
