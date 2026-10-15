import { describe, expect, it } from 'vitest';
import type { MemberAnnouncement, MemberNoticeWire } from '@got/shared';
import {
  BELL_ROWS,
  bellRowHref,
  bellRowKey,
  bellRows,
  bellView,
  noticeLink,
  seenMarks,
  type BellRow,
} from './bell';

function announcement(id: string, createdAt: string): MemberAnnouncement {
  return {
    id,
    title: `Announcement ${id}`,
    content: 'Body',
    contentJson: null,
    coverImageUrl: null,
    isPinned: false,
    author: { id: 'a1', firstName: 'Ana', lastName: 'Cruz' },
    createdAt,
    updatedAt: createdAt,
    isNew: true,
  };
}

function notice(
  id: string,
  createdAt: string,
  over: Partial<MemberNoticeWire> = {},
): MemberNoticeWire {
  return {
    id,
    kind: 'CLASS_CANCELLED',
    title: `Cancelled: Yoga (${id})`,
    body: 'Coach is unwell.',
    linkPath: '/portal/book?date=2026-10-14',
    isNew: true,
    createdAt,
    ...over,
  };
}

/** The n-th hour of 11 Oct 2026, so a bigger number is a newer row. */
const at = (hour: number): string => `2026-10-11T${String(hour).padStart(2, '0')}:00:00.000Z`;

const keys = (rows: readonly BellRow[]): string[] => rows.map(bellRowKey);

describe('bellRows', () => {
  it('merges both feeds newest first', () => {
    const rows = bellRows(
      [announcement('a1', at(1)), announcement('a3', at(3))],
      [notice('n2', at(2)), notice('n4', at(4))],
    );
    expect(keys(rows)).toEqual(['notice:n4', 'announcement:a3', 'notice:n2', 'announcement:a1']);
  });

  it(`cuts at ${BELL_ROWS} rows by default`, () => {
    const many = Array.from({ length: 10 }, (_, i) => announcement(`a${i}`, at(i)));
    expect(bellRows(many, [notice('n', at(20))])).toHaveLength(BELL_ROWS);
    expect(bellRows(many, [], 3).map((row) => row.item.id)).toEqual(['a9', 'a8', 'a7']);
  });

  it('breaks a createdAt tie by id, descending, across feeds too', () => {
    const rows = bellRows([announcement('b', at(5))], [notice('c', at(5)), notice('a', at(5))]);
    expect(keys(rows)).toEqual(['notice:c', 'announcement:b', 'notice:a']);
  });

  /** The console mounts the bell with no notices provider. */
  it('lists announcements alone when there are no notices', () => {
    expect(keys(bellRows([announcement('a1', at(1))], []))).toEqual(['announcement:a1']);
  });
});

describe('seenMarks', () => {
  it("marks each feed up to its own newest row on screen — never 'now'", () => {
    const rows = bellRows(
      [announcement('a1', at(1)), announcement('a3', at(3))],
      [notice('n2', at(2))],
    );
    expect(seenMarks(rows)).toEqual({ announcements: at(3), notices: at(2) });
  });

  /**
   * Eight newer announcements push every notice below the cut: the member saw
   * none of them, so opening the bell must not mark them read.
   */
  it('marks nothing for a feed with no row on screen', () => {
    const newer = Array.from({ length: BELL_ROWS }, (_, i) => announcement(`a${i}`, at(10 + i)));
    const rows = bellRows(newer, [notice('n-old', at(1))]);
    expect(seenMarks(rows)).toEqual({ announcements: at(10 + BELL_ROWS - 1), notices: null });
  });

  it('marks nothing at all for an empty bell', () => {
    expect(seenMarks([])).toEqual({ announcements: null, notices: null });
  });
});

describe('bellRowHref', () => {
  it('sends an announcement to the noticeboard of this surface', () => {
    const [row] = bellRows([announcement('a1', at(1))], []);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(bellRowHref(row, '/portal/dashboard')).toBe('/portal/dashboard?notice=a1');
    expect(bellRowHref(row, '/admin')).toBe('/admin?notice=a1');
  });

  /**
   * The trap: `noticeHref` would send the member to the dashboard, which looks
   * the id up as an ANNOUNCEMENT, fails, and says it is no longer available.
   */
  it('sends a member notice to its own linkPath, never to ?notice=', () => {
    const [row] = bellRows([], [notice('n1', at(1))]);
    expect(row).toBeDefined();
    if (row === undefined) return;
    const href = bellRowHref(row, '/portal/dashboard');
    expect(href).toBe('/portal/book?date=2026-10-14');
    expect(href).not.toContain('notice=');
  });

  it('gives a notice with no link nowhere to go', () => {
    const [row] = bellRows([], [notice('n1', at(1), { linkPath: null })]);
    expect(row).toBeDefined();
    if (row === undefined) return;
    expect(bellRowHref(row, '/portal/dashboard')).toBeNull();
  });
});

describe('noticeLink', () => {
  it('keeps an in-app path, query and all', () => {
    expect(noticeLink('/portal/book?date=2026-10-14')).toBe('/portal/book?date=2026-10-14');
    expect(noticeLink('/portal/schedule')).toBe('/portal/schedule');
  });

  /** The database refuses these already (MemberNotice_link_is_internal); this is the second lock. */
  it.each([
    ['nothing', null],
    ['an empty string', ''],
    ['an absolute URL', 'https://evil.example/portal'],
    ['a protocol-relative URL', '//evil.example/portal'],
    ['a backslash', '/\\evil.example'],
    ['a dot-dot segment', '/portal/../evil'],
    ['a path outside every surface', '/elsewhere'],
  ])('refuses %s', (_label, linkPath) => {
    expect(noticeLink(linkPath)).toBeNull();
  });
});

describe('bellView', () => {
  const ready = { status: 'ready', forbidden: false } as const;
  const loading = { status: 'loading', forbidden: false } as const;
  const idle = { status: 'idle', forbidden: false } as const;
  const failed = { status: 'error', forbidden: false } as const;
  const forbidden = { status: 'error', forbidden: true } as const;

  it('shows the list whenever there are rows, even with the other feed still loading', () => {
    expect(bellView([ready, loading], 3)).toEqual({ view: 'list', partialFailure: false });
  });

  it('says so, quietly, when one feed failed and the other has rows', () => {
    expect(bellView([ready, failed], 3)).toEqual({ view: 'list', partialFailure: true });
  });

  /** "Nothing yet" must not flash before the slower feed lands. */
  it('shows the skeleton while any feed is on its first load and nothing is on screen', () => {
    expect(bellView([ready, loading], 0).view).toBe('loading');
    expect(bellView([idle], 0).view).toBe('loading');
  });

  it('shows the error when nothing arrived and a feed failed', () => {
    expect(bellView([failed, ready], 0).view).toBe('error');
    expect(bellView([failed], 0).view).toBe('error');
  });

  it('shows the empty state when every feed answered with nothing', () => {
    expect(bellView([ready, ready], 0)).toEqual({ view: 'empty', partialFailure: false });
  });

  /** A 403 is the account's answer, not a failure to report. */
  it('leaves a feed this account may not read out of it entirely', () => {
    expect(bellView([forbidden, ready], 0).view).toBe('empty');
    expect(bellView([forbidden, ready], 2)).toEqual({ view: 'list', partialFailure: false });
  });
});
