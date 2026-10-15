import { ANNOUNCEMENT_CONTENT_MAX, type AnnouncementDoc } from '@got/shared';
import { derivedLength } from './rich';

export interface AnnouncementPayload {
  title: string;
  contentJson?: AnnouncementDoc;
  coverImageUrl?: string | null;
  isPinned: boolean;
}

/**
 * What the composer sends.
 *
 * Posting always sends the document. EDITING sends the body only when the
 * admin actually changed it: an old plain notice opened to fix its title or
 * pin it must stay plain, not be quietly re-saved as the editor's conversion
 * of it (which would also log a body change nobody made). The cover travels
 * only when it changed, and `null` is how it is removed.
 */
export function announcementPayload(input: {
  existing: { contentJson: AnnouncementDoc | null; coverImageUrl: string | null } | null;
  title: string;
  doc: AnnouncementDoc;
  bodyTouched: boolean;
  cover: string | null;
  isPinned: boolean;
}): AnnouncementPayload {
  const title = input.title.trim();

  if (input.existing === null) {
    return {
      title,
      contentJson: input.doc,
      ...(input.cover === null ? {} : { coverImageUrl: input.cover }),
      isPinned: input.isPinned,
    };
  }

  return {
    title,
    ...(input.bodyTouched ? { contentJson: input.doc } : {}),
    ...(input.cover === input.existing.coverImageUrl ? {} : { coverImageUrl: input.cover }),
    isPinned: input.isPinned,
  };
}

/** Why the composer cannot post yet, in words — or null when it can. */
export function composerProblem(title: string, doc: AnnouncementDoc): string | null {
  if (title.trim() === '') return 'Give the notice a title.';
  const length = derivedLength(doc);
  if (length === 0) return 'Write some text — the bell and previews show it.';
  if (length > ANNOUNCEMENT_CONTENT_MAX) {
    return `The message is over ${ANNOUNCEMENT_CONTENT_MAX.toLocaleString('en-US')} characters.`;
  }
  return null;
}
