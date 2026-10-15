import { describe, expect, it } from 'vitest';
import { CATCH_UP_MIN_INTERVAL_MS, parseChatBroadcast, shouldCatchUp } from './realtime';

const message = {
  id: 'm1',
  threadId: 't1',
  senderId: 'u1',
  body: 'Hello',
  createdAt: '2026-09-25T02:00:00.000Z',
  editedAt: null,
  deletedAt: null,
};

describe('parseChatBroadcast', () => {
  it('accepts the shape the server broadcasts', () => {
    expect(parseChatBroadcast({ threadId: 't1', message, clientId: 'tmp' })).toEqual({
      threadId: 't1',
      message,
      clientId: 'tmp',
    });
    expect(parseChatBroadcast({ threadId: 't1', message, clientId: null })?.clientId).toBeNull();
  });

  it('accepts a tombstone', () => {
    const tombstone = { ...message, body: null, deletedAt: '2026-09-25T02:01:00.000Z' };
    expect(
      parseChatBroadcast({ threadId: 't1', message: tombstone, clientId: null })?.message,
    ).toEqual(tombstone);
  });

  it.each([
    null,
    'text',
    {},
    { threadId: 't1' },
    { threadId: 't1', message: { ...message, id: 5 }, clientId: null },
    { threadId: 't1', message: { ...message, body: { html: '<b>x</b>' } }, clientId: null },
    // A message that claims to belong to a different thread than its envelope.
    { threadId: 't2', message, clientId: null },
  ])('refuses %p', (payload) => {
    expect(parseChatBroadcast(payload)).toBeNull();
  });
});

describe('shouldCatchUp', () => {
  it('always catches up the first time', () => {
    expect(shouldCatchUp(null, 1_000)).toBe(true);
  });

  it('coalesces a burst of focus and reconnect events', () => {
    expect(shouldCatchUp(1_000, 1_000 + CATCH_UP_MIN_INTERVAL_MS - 1)).toBe(false);
    expect(shouldCatchUp(1_000, 1_000 + CATCH_UP_MIN_INTERVAL_MS)).toBe(true);
  });
});
