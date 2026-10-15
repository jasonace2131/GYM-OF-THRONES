import { Reflector } from '@nestjs/core';
import { UserThrottlerGuard } from './user-throttler.guard';

/** `getTracker` is protected on ThrottlerGuard; this is the narrow escape hatch. */
interface TrackerAccess {
  getTracker(req: unknown): Promise<string>;
}

describe('UserThrottlerGuard', () => {
  let guard: UserThrottlerGuard;
  let tracker: TrackerAccess;

  beforeEach(() => {
    guard = new UserThrottlerGuard(
      [{ ttl: 60_000, limit: 100 }],
      { increment: jest.fn() },
      new Reflector(),
    );
    tracker = guard as unknown as TrackerAccess;
  });

  it('tracks an authenticated request by user id, not by IP', async () => {
    const req = {
      ip: '203.0.113.9',
      user: { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
    };
    await expect(tracker.getTracker(req)).resolves.toBe(
      'user:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
    );
  });

  it('gives two users behind one NAT address independent budgets', async () => {
    const first = { ip: '203.0.113.9', user: { id: 'user-one' } };
    const second = { ip: '203.0.113.9', user: { id: 'user-two' } };
    const [a, b] = await Promise.all([tracker.getTracker(first), tracker.getTracker(second)]);
    expect(a).not.toBe(b);
  });

  it('falls back to the client IP on a @Public() route with no user', async () => {
    await expect(tracker.getTracker({ ip: '198.51.100.4' })).resolves.toBe('ip:198.51.100.4');
  });

  it('falls back to a stable literal when express cannot determine an IP', async () => {
    await expect(tracker.getTracker({})).resolves.toBe('ip:unknown');
  });

  it('tracks a station-display request by a hash of X-Station-Key, ahead of user/IP', async () => {
    const req = {
      ip: '203.0.113.9',
      headers: { 'x-station-key': 'super-secret-station-key' },
    };
    const tracked = await tracker.getTracker(req);
    expect(tracked).toMatch(/^station-key:[0-9a-f]{64}$/);
  });

  it('gives two different station keys independent budgets, and never logs the raw key', async () => {
    const first = { headers: { 'x-station-key': 'key-one' } };
    const second = { headers: { 'x-station-key': 'key-two' } };
    const [a, b] = await Promise.all([tracker.getTracker(first), tracker.getTracker(second)]);
    expect(a).not.toBe(b);
    expect(a).not.toContain('key-one');
    expect(b).not.toContain('key-two');
  });
});
