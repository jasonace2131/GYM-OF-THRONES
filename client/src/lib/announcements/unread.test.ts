import { describe, expect, it } from 'vitest';
import { bellLabel, countRose, unreadBadge } from './unread';

/**
 * Pinned wording. It changed on purpose on 2026-10-11: the portal's bell now
 * carries the member's own notices beside the announcements, so it says
 * "notifications"; the console's bell (announcements only) keeps its noun.
 */

describe('unreadBadge', () => {
  it('shows nothing, and says so, at zero', () => {
    expect(unreadBadge(0)).toEqual({ text: null, spoken: 'No new notifications' });
  });

  it('treats a negative count as zero', () => {
    expect(unreadBadge(-2).text).toBeNull();
  });

  it('is singular at one', () => {
    expect(unreadBadge(1)).toEqual({ text: '1', spoken: '1 new notification' });
  });

  it('shows the digit up to nine', () => {
    expect(unreadBadge(3)).toEqual({ text: '3', spoken: '3 new notifications' });
    expect(unreadBadge(9).text).toBe('9');
  });

  /** The pill caps; the words do not — a screen reader hears the real number. */
  it('caps the pill at 9+ but speaks the real count', () => {
    expect(unreadBadge(10)).toEqual({ text: '9+', spoken: '10 new notifications' });
    expect(unreadBadge(42)).toEqual({ text: '9+', spoken: '42 new notifications' });
  });

  /** The console's bell lists announcements only. */
  it('says "announcements" where that is all the bell carries', () => {
    expect(unreadBadge(0, 'announcement').spoken).toBe('No new announcements');
    expect(unreadBadge(1, 'announcement').spoken).toBe('1 new announcement');
    expect(unreadBadge(12, 'announcement')).toEqual({ text: '9+', spoken: '12 new announcements' });
  });
});

describe('bellLabel', () => {
  it('names the control and its state as one short phrase', () => {
    expect(bellLabel(3)).toBe('Notifications, 3 new');
    expect(bellLabel(1)).toBe('Notifications, 1 new');
    expect(bellLabel(0)).toBe('Notifications, nothing new');
  });

  it('says the real number past the pill cap, and never a negative', () => {
    expect(bellLabel(42)).toBe('Notifications, 42 new');
    expect(bellLabel(-1)).toBe('Notifications, nothing new');
  });

  /**
   * The console has its own "Notifications" section (system alerts) under the
   * same bell icon; its topbar bell must not be mistaken for it.
   */
  it('keeps the console bell named for what it lists', () => {
    expect(bellLabel(3, 'announcement')).toBe('Announcements, 3 new');
    expect(bellLabel(0, 'announcement')).toBe('Announcements, nothing new');
  });
});

describe('countRose', () => {
  /** The first load is not news — the badge is already there when the page appears. */
  it('is false on the first load', () => {
    expect(countRose(null, 3)).toBe(false);
  });

  it('is true when a refresh brings more than the server last reported', () => {
    expect(countRose(1, 2)).toBe(true);
    expect(countRose(0, 1)).toBe(true);
  });

  it('is false when the count holds or falls', () => {
    expect(countRose(2, 2)).toBe(false);
    expect(countRose(3, 0)).toBe(false);
  });
});
