import {
  ANNOUNCEMENT_ORDER,
  MEMBER_FEED_ORDER,
  toAnnouncement,
  toMemberAnnouncement,
  type AnnouncementRow,
} from './announcement.presenter';

const ROW: AnnouncementRow = {
  id: '11111111-1111-4111-8111-111111111111',
  title: 'Gym closes early this Saturday',
  content: 'We close at 6pm on the 29th for maintenance.',
  contentJson: null,
  coverImageUrl: null,
  isPinned: true,
  // 22:30 UTC on the 25th is 06:30 on the 26th in Manila — the case that
  // catches a presenter formatting on the server's clock.
  createdAt: new Date('2026-08-25T22:30:00.000Z'),
  updatedAt: new Date('2026-08-25T23:00:00.000Z'),
  author: { id: '22222222-2222-4222-8222-222222222222', firstName: 'Ana', lastName: 'Cruz' },
};

describe('toAnnouncement', () => {
  it('projects the row onto the wire shape', () => {
    expect(toAnnouncement(ROW)).toEqual({
      id: ROW.id,
      title: 'Gym closes early this Saturday',
      content: 'We close at 6pm on the 29th for maintenance.',
      contentJson: null,
      coverImageUrl: null,
      isPinned: true,
      author: { id: ROW.author.id, firstName: 'Ana', lastName: 'Cruz' },
      createdAt: '2026-08-25T22:30:00.000Z',
      updatedAt: '2026-08-25T23:00:00.000Z',
    });
  });

  it('carries a rich notice’s JSON and cover alongside the derived plain text', () => {
    const doc = {
      type: 'doc',
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'We close at 6pm.' }] }],
    };
    const cover =
      'https://x.supabase.co/storage/v1/object/public/announcements/announcements/0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp';

    const result = toAnnouncement({ ...ROW, contentJson: doc, coverImageUrl: cover });

    expect(result.contentJson).toEqual(doc);
    expect(result.coverImageUrl).toBe(cover);
    expect(result.content).toBe(ROW.content);
  });

  /**
   * Instants go out as ISO strings, never pre-formatted.
   *
   * A formatted date in a response body is a date formatted in the SERVER's
   * zone and shipped to a phone in another one. Every surface renders its own
   * with an explicit `timeZone` — the same rule money follows with centavos.
   */
  it('sends instants as ISO, not as display text', () => {
    const result = toAnnouncement(ROW);
    expect(result.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(result.createdAt).not.toContain('Aug');
  });

  /**
   * The author is named, and nothing else about them is.
   *
   * A notice from the owner and one from the front desk carry different
   * weight, so the name earns its place. Email, role and member code do not —
   * this payload goes to every member.
   */
  it('exposes only the author fields a member needs', () => {
    const author = toAnnouncement(ROW).author;
    expect(Object.keys(author).sort()).toEqual(['firstName', 'id', 'lastName']);
  });
});

describe('ANNOUNCEMENT_ORDER', () => {
  /**
   * Pinned first, then newest — and the migration's composite index is built
   * on exactly these two keys in exactly this order. If one changes without
   * the other, the feed silently starts sorting in memory.
   */
  it('is pinned-first then newest-first', () => {
    expect(ANNOUNCEMENT_ORDER).toEqual([{ isPinned: 'desc' }, { createdAt: 'desc' }]);
  });
});

describe('toMemberAnnouncement', () => {
  it('is the wire shape plus isNew', () => {
    const floor = new Date('2026-08-20T00:00:00.000Z');
    expect(toMemberAnnouncement(ROW, floor)).toEqual({ ...toAnnouncement(ROW), isNew: true });
  });

  /**
   * STRICT. The watermark is set to the createdAt of the newest notice the
   * member was shown, so that exact notice must read as seen afterwards — a
   * `>=` here would leave the one notice they just looked at lit forever.
   */
  it('is not new when created exactly at the floor', () => {
    expect(toMemberAnnouncement(ROW, new Date(ROW.createdAt)).isNew).toBe(false);
  });

  it('is new one millisecond after the floor', () => {
    const floor = new Date(ROW.createdAt.getTime() - 1);
    expect(toMemberAnnouncement(ROW, floor).isNew).toBe(true);
  });

  it('is not new before the floor', () => {
    const floor = new Date(ROW.createdAt.getTime() + 60_000);
    expect(toMemberAnnouncement(ROW, floor).isNew).toBe(false);
  });
});

describe('MEMBER_FEED_ORDER', () => {
  /**
   * CHRONOLOGICAL, not pinned-first. Pinned-first would park an old pinned
   * notice at the top of the bell forever and push the notice that just went
   * up beneath it. Pinned notices travel separately (`feed.pinned`). The id
   * tie-break makes the order total, so a page boundary between two notices
   * saved in the same millisecond cannot repeat or drop one.
   */
  it('is newest first, with the id as a total tie-break', () => {
    expect(MEMBER_FEED_ORDER).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});
