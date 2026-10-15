import {
  MEMBER_NOTICE_ORDER,
  MEMBER_NOTICE_SELECT,
  toMemberNotice,
  type MemberNoticeRow,
} from './member-notice.presenter';

const CREATED = new Date('2026-10-11T03:15:00.000Z');

function row(over: Partial<MemberNoticeRow> = {}): MemberNoticeRow {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    kind: 'BOOKING_REMOVED',
    title: 'Removed from Spin, Wed 14 Oct 6:00 pm',
    body: 'The class is for the beginners group this week.',
    linkPath: '/portal/book?date=2026-10-14',
    readAt: null,
    createdAt: CREATED,
    ...over,
  };
}

describe('toMemberNotice', () => {
  it('projects a row onto the wire shape, the instant as ISO', () => {
    expect(toMemberNotice(row())).toEqual({
      id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      kind: 'BOOKING_REMOVED',
      title: 'Removed from Spin, Wed 14 Oct 6:00 pm',
      body: 'The class is for the beginners group this week.',
      linkPath: '/portal/book?date=2026-10-14',
      isNew: true,
      createdAt: '2026-10-11T03:15:00.000Z',
    });
  });

  /** The row's OWN read state — no watermark, no 30-day horizon. */
  it('is new exactly while the row is unread, however old it is', () => {
    const old = new Date('2025-01-01T00:00:00.000Z');
    expect(toMemberNotice(row({ createdAt: old })).isNew).toBe(true);
    expect(toMemberNotice(row({ readAt: new Date('2026-10-11T03:16:00.000Z') })).isNew).toBe(false);
  });

  it('passes a missing body and link through as null', () => {
    const view = toMemberNotice(row({ body: null, linkPath: null }));
    expect(view.body).toBeNull();
    expect(view.linkPath).toBeNull();
  });

  /**
   * The recipient is the caller, and the subject and the dedupe key are the
   * producer's bookkeeping. None of them reaches the wire, and neither does
   * the read stamp itself — `isNew` is all a client needs.
   */
  it('sends exactly the seven wire fields', () => {
    expect(Object.keys(toMemberNotice(row())).sort()).toEqual([
      'body',
      'createdAt',
      'id',
      'isNew',
      'kind',
      'linkPath',
      'title',
    ]);
  });
});

describe('MEMBER_NOTICE_SELECT', () => {
  /** Loads what the presenter reads and nothing more — never userId, subject or dedupe key. */
  it('selects exactly the columns of MemberNoticeRow', () => {
    expect(Object.keys(MEMBER_NOTICE_SELECT).sort()).toEqual(Object.keys(row()).sort());
  });
});

describe('MEMBER_NOTICE_ORDER', () => {
  it('is newest first with the id as the tie-break — a total order, so pages never overlap', () => {
    expect(MEMBER_NOTICE_ORDER).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
  });
});
