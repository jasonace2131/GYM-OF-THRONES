import { UNREAD_HORIZON_DAYS, clampSeenUpTo, effectiveSeenAt } from './announcement-watermark';

const NOW = new Date('2026-09-24T04:00:00.000Z');
const DAY = 86_400_000;
const HORIZON = new Date(NOW.getTime() - UNREAD_HORIZON_DAYS * DAY);

describe('UNREAD_HORIZON_DAYS', () => {
  it('is thirty days — the owner decision, pinned so a change is deliberate', () => {
    expect(UNREAD_HORIZON_DAYS).toBe(30);
  });
});

describe('effectiveSeenAt', () => {
  /**
   * A member who has never opened the bell has seen nothing — but they also
   * joined on a known day, and every notice before it is history, not news.
   * Without this a brand-new account would open the portal to "23 new".
   */
  it('reads a NULL watermark as the account creation instant', () => {
    const createdAt = new Date(NOW.getTime() - 3 * DAY);
    expect(effectiveSeenAt({ announcementsSeenAt: null, createdAt }, NOW)).toEqual(createdAt);
  });

  it('uses the stored watermark when there is one', () => {
    const seen = new Date(NOW.getTime() - 2 * DAY);
    const createdAt = new Date(NOW.getTime() - 20 * DAY);
    expect(effectiveSeenAt({ announcementsSeenAt: seen, createdAt }, NOW)).toEqual(seen);
  });

  /**
   * The horizon: a member back after six months is not greeted by every notice
   * posted while they were away. Thirty days of news, at most.
   */
  it('floors an old account with no watermark at the horizon', () => {
    const createdAt = new Date(NOW.getTime() - 400 * DAY);
    expect(effectiveSeenAt({ announcementsSeenAt: null, createdAt }, NOW)).toEqual(HORIZON);
  });

  it('floors an old watermark at the horizon', () => {
    const seen = new Date(NOW.getTime() - 90 * DAY);
    const createdAt = new Date(NOW.getTime() - 400 * DAY);
    expect(effectiveSeenAt({ announcementsSeenAt: seen, createdAt }, NOW)).toEqual(HORIZON);
  });

  it('returns the horizon itself on the equality boundary', () => {
    expect(
      effectiveSeenAt({ announcementsSeenAt: new Date(HORIZON), createdAt: new Date(0) }, NOW),
    ).toEqual(HORIZON);
    // One millisecond inside the horizon wins over the horizon.
    const inside = new Date(HORIZON.getTime() + 1);
    expect(effectiveSeenAt({ announcementsSeenAt: inside, createdAt: new Date(0) }, NOW)).toEqual(
      inside,
    );
  });

  it('never hands back the caller its own Date object to mutate', () => {
    const seen = new Date(NOW.getTime() - DAY);
    const result = effectiveSeenAt({ announcementsSeenAt: seen, createdAt: new Date(0) }, NOW);
    expect(result).not.toBe(seen);
  });
});

describe('clampSeenUpTo', () => {
  /**
   * `upTo` is the createdAt of the newest notice the member was SHOWN, so it
   * is always in the past. A client clock or a hand-made request that sends
   * 2099 must not mark next year's notices as read before they exist.
   */
  it('clamps a future instant to now', () => {
    expect(clampSeenUpTo(new Date('2099-01-01T00:00:00.000Z'), NOW)).toEqual(NOW);
  });

  it('keeps a past instant as it is', () => {
    const past = new Date(NOW.getTime() - 5_000);
    expect(clampSeenUpTo(past, NOW)).toEqual(past);
  });

  it('keeps now as now', () => {
    expect(clampSeenUpTo(new Date(NOW), NOW)).toEqual(NOW);
  });
});
