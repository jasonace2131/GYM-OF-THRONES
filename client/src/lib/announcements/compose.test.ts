import { describe, expect, it } from 'vitest';
import type { AnnouncementDoc } from '@got/shared';
import { announcementPayload, composerProblem } from './compose';
import { plainTextToDoc } from './rich';

const DOC: AnnouncementDoc = plainTextToDoc('We close at 6pm.');
const COVER = 'https://x.supabase.co/storage/v1/object/public/announcements/announcements/c.webp';

describe('announcementPayload — posting', () => {
  it('sends the document, never plain content', () => {
    expect(
      announcementPayload({
        existing: null,
        title: '  Holiday hours ',
        doc: DOC,
        bodyTouched: false,
        cover: null,
        isPinned: false,
      }),
    ).toEqual({ title: 'Holiday hours', contentJson: DOC, isPinned: false });
  });

  it('includes a cover only when there is one', () => {
    expect(
      announcementPayload({
        existing: null,
        title: 'x',
        doc: DOC,
        bodyTouched: true,
        cover: COVER,
        isPinned: true,
      }),
    ).toEqual({ title: 'x', contentJson: DOC, coverImageUrl: COVER, isPinned: true });
  });
});

describe('announcementPayload — editing', () => {
  const plainExisting = { contentJson: null, coverImageUrl: null };

  /**
   * An untouched old notice stays PLAIN. Sending the editor's conversion of it
   * would silently turn every retitle or pin into a body rewrite in the audit
   * log, and change nothing a member could see.
   */
  it('leaves the body alone when the admin did not touch it', () => {
    const payload = announcementPayload({
      existing: plainExisting,
      title: 'New title',
      doc: DOC,
      bodyTouched: false,
      cover: null,
      isPinned: false,
    });
    expect(payload).toEqual({ title: 'New title', isPinned: false });
  });

  it('sends the document once the body was edited', () => {
    expect(
      announcementPayload({
        existing: plainExisting,
        title: 't',
        doc: DOC,
        bodyTouched: true,
        cover: null,
        isPinned: false,
      }).contentJson,
    ).toEqual(DOC);
  });

  it('sends a cover change — including null to remove it — and nothing when unchanged', () => {
    const withCover = { contentJson: DOC, coverImageUrl: COVER };
    const base = { title: 't', doc: DOC, bodyTouched: false, isPinned: false };

    expect(announcementPayload({ ...base, existing: withCover, cover: null })).toHaveProperty(
      'coverImageUrl',
      null,
    );
    expect(announcementPayload({ ...base, existing: withCover, cover: COVER })).not.toHaveProperty(
      'coverImageUrl',
    );
  });
});

describe('composerProblem', () => {
  it('is fine with a title and some text', () => {
    expect(composerProblem('Hours', DOC)).toBeNull();
  });

  it('wants a title', () => {
    expect(composerProblem('   ', DOC)).toMatch(/title/i);
  });

  it('wants some text — an image alone gives the bell nothing to show', () => {
    expect(composerProblem('Hours', plainTextToDoc(''))).toMatch(/text/i);
  });

  it('refuses a body over the limit before the server has to', () => {
    expect(composerProblem('Hours', plainTextToDoc('x'.repeat(4001)))).toMatch(/4,000/);
  });
});
