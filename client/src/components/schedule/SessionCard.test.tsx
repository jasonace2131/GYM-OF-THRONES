import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

// The card formats with `@/lib/classes`, which imports the API client, which
// needs Supabase's env at import. Nothing here talks to the network.
vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import type { ClassSession, MyBooking } from '@/lib/classes';
import { at, booking, session } from '@/lib/schedule/fixtures';
import { SessionCard } from './SessionCard';

/**
 * The timetable card's action state machine, rendered to a string with
 * react-dom/server like RichContent.test.tsx, so what a member can tap is
 * asserted on the markup itself. Every rule here is one the server enforces
 * too; these pin that the card never OFFERS what the server would refuse.
 *
 * The fixture class is Wed 16 Sep 2026, 6:00–7:00 PM Manila. Its waitlist
 * closes 120 minutes before the start, at 4:00 PM.
 */

const FULL: Partial<ClassSession> = {
  isFull: true,
  seatsLeft: 0,
  bookedCount: 16,
  waitlistCount: 3,
};

const noop = (): void => undefined;

interface Rendered {
  /** The status pill's words, or null without one. */
  badge: string | null;
  /** Every button's label, in order. */
  buttons: string[];
  /** All the card's words, tags stripped. */
  text: string;
}

/** Strips tags and the `<!-- -->` React puts between adjacent text nodes. */
function plain(markup: string): string {
  return markup
    .replace(/<!-- -->/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

function render(
  item: ClassSession,
  mine: MyBooking | undefined,
  now: Date,
  { canBook = true }: { canBook?: boolean } = {},
): Rendered {
  const markup = renderToStaticMarkup(
    <SessionCard
      session={item}
      booking={mine}
      now={now}
      busy={false}
      onBook={canBook ? noop : undefined}
      onCancel={canBook ? noop : undefined}
    />,
  );
  const badge = /<span[^>]*data-slot="badge"[^>]*>(.*?)<\/span>/.exec(markup);
  return {
    badge: badge === null ? null : plain(badge[1] as string),
    buttons: [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((match) =>
      plain(match[1] as string),
    ),
    text: plain(markup),
  };
}

/** A class with no booking of the member's. */
const card = (over: Partial<ClassSession>, now: Date, options?: { canBook?: boolean }) =>
  render(session(over), undefined, now, options);

/** A class the member holds `mine` in. */
const held = (mine: MyBooking, now: Date) => render(mine.session, mine, now);

describe('SessionCard — a class the member is not in', () => {
  it('seats free: Book', () => {
    const view = card({}, at('2026-09-16', '12:00'));
    expect(view.buttons).toEqual(['Book']);
    expect(view.text).toContain('14 of 16 places left');
  });

  it('full, before the cutoff (3:59 PM): Join waitlist, and when the waitlist closes', () => {
    const view = card(FULL, at('2026-09-16', '15:59'));
    expect(view.badge).toBe('Full');
    expect(view.buttons).toEqual(['Join waitlist']);
    expect(view.text).toContain('3 waiting · Waitlist closes 4:00 PM');
  });

  /** Owner, 2026-10-11: from the cutoff on nobody joins the waitlist. */
  it('full, from the cutoff (4:00 PM) to the start (5:59 PM): closed, nothing to join', () => {
    for (const now of [at('2026-09-16', '16:00'), at('2026-09-16', '17:59')]) {
      const view = card(FULL, now);
      expect(view.badge).toBe('Full · waitlist closed');
      expect(view.buttons).toEqual([]);
      expect(view.text).toContain('A place that frees up now goes to whoever books it first.');
    }
  });

  it('started (6:00 PM): no Book and no Join, full or not', () => {
    const started = at('2026-09-16', '18:00');
    for (const view of [card({}, started), card(FULL, started)]) {
      expect(view.badge).toBe('Started');
      expect(view.buttons).toEqual([]);
      expect(view.text).toContain('Booking closed at 6:00 PM');
      // A started class has no queue left to count.
      expect(view.text).not.toContain('waiting');
    }
  });

  it('cancelled by the gym: the reason, and no actions', () => {
    const view = card(
      { ...FULL, cancelledAt: '2026-09-15T00:00:00.000Z', cancelReason: 'Coach is ill' },
      at('2026-09-16', '12:00'),
    );
    expect(view.badge).toBe('Class cancelled');
    expect(view.buttons).toEqual([]);
    expect(view.text).toContain('Coach is ill');
    expect(view.text).not.toContain('waiting');
  });

  /** A caller without `booking.create` (staff, coaches) gets a read-only card. */
  it('without booking.create: no buttons at all', () => {
    expect(card({}, at('2026-09-16', '12:00'), { canBook: false }).buttons).toEqual([]);
    const full = card(FULL, at('2026-09-16', '15:59'), { canBook: false });
    expect(full.buttons).toEqual([]);
    expect(full.text).toContain('This class is full. · 3 waiting');
  });
});

describe('SessionCard — a class the member holds', () => {
  it('own BOOKED before the start: Cancel, and until when', () => {
    const view = held(booking('BOOKED'), at('2026-09-16', '12:00'));
    expect(view.badge).toBe('Booked');
    expect(view.buttons).toEqual(['Cancel']);
    expect(view.text).toContain('Cancel until 6:00 PM today');
  });

  it('own BOOKED once started: no Cancel', () => {
    const view = held(booking('BOOKED'), at('2026-09-16', '18:00'));
    expect(view.badge).toBe('Not marked');
    expect(view.buttons).toEqual([]);
  });

  it('own WAITLISTED on a full class before the cutoff: the queue place, and Leave', () => {
    const view = held(
      booking('WAITLISTED', FULL, 'b1', { waitlistPosition: 2 }),
      at('2026-09-16', '15:59'),
    );
    expect(view.badge).toBe('Waitlist · #2');
    expect(view.buttons).toEqual(['Leave waitlist']);
    expect(view.text).toContain('3 waiting · Waitlist closes 4:00 PM');
  });

  it('own WAITLISTED with a free seat after the cutoff: Take the free place', () => {
    const view = held(
      booking('WAITLISTED', { seatsLeft: 1, bookedCount: 15, isFull: false }, 'b1', {
        waitlistPosition: null,
      }),
      at('2026-09-16', '16:30'),
    );
    expect(view.badge).toBe('Waitlist closed');
    expect(view.buttons).toEqual(['Take the free place', 'Leave waitlist']);
    expect(view.text).toContain('A place is free. It goes to whoever books it first.');
  });

  it('own WAITLISTED once started: No place, and no actions', () => {
    const view = held(booking('WAITLISTED', FULL), at('2026-09-16', '18:00'));
    expect(view.badge).toBe('No place');
    expect(view.buttons).toEqual([]);
    expect(view.text).toContain("The waitlist didn't reach you.");
  });

  it('a class the gym cancelled: Class cancelled, and no actions', () => {
    const view = held(
      booking('BOOKED', { cancelledAt: '2026-09-15T00:00:00.000Z', cancelReason: 'Coach is ill' }),
      at('2026-09-16', '12:00'),
    );
    expect(view.badge).toBe('Class cancelled');
    expect(view.buttons).toEqual([]);
  });
});

describe('SessionCard — the coach running the class (owner, 2026-10-23)', () => {
  const coachView = (onEdit?: () => void, onCancelClass?: () => void) => {
    const markup = renderToStaticMarkup(
      <SessionCard
        session={session({})}
        booking={undefined}
        now={at('2026-09-16', '12:00')}
        busy={false}
        onEdit={onEdit}
        onCancelClass={onCancelClass}
      />,
    );
    return [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/g)].map((m) => plain(m[1] as string));
  };

  it('offers Edit and Cancel class when the page hands them over, and no Book', () => {
    expect(coachView(noop, noop)).toEqual(['Edit', 'Cancel class']);
    expect(coachView(noop, undefined)).toEqual(['Edit']);
    expect(coachView()).toEqual([]);
  });
});
