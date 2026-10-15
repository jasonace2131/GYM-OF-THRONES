import { describe, expect, it } from 'vitest';
import type { ChatMessageView, ChatThreadView } from '@got/shared';
import { messageTime, otherParty, threadPreview } from './format';

const TZ = 'Asia/Manila';

describe('messageTime', () => {
  const now = new Date('2026-09-25T04:00:00.000Z'); // 12:00 noon in Manila

  it('shows only the time for a message from the gym day it is now', () => {
    expect(messageTime('2026-09-25T01:05:00.000Z', now, TZ)).toBe('9:05 AM');
  });

  it('adds the date for anything older — in the gym clock, not UTC', () => {
    // 23:30 UTC on the 24th is 07:30 on the 25th in Manila: still "today".
    expect(messageTime('2026-09-24T23:30:00.000Z', now, TZ)).toBe('7:30 AM');
    expect(messageTime('2026-09-24T01:05:00.000Z', now, TZ)).toBe('Sep 24, 9:05 AM');
  });
});

describe('threadPreview', () => {
  const base: ChatMessageView = {
    id: 'm',
    threadId: 't',
    senderId: 'me',
    body: 'See you at six',
    createdAt: '2026-09-25T01:00:00.000Z',
    editedAt: null,
    deletedAt: null,
  };

  it('says who wrote it when it was me, and says nothing yet for a silent thread', () => {
    expect(threadPreview(base, 'me')).toBe('You: See you at six');
    expect(threadPreview({ ...base, senderId: 'them' }, 'me')).toBe('See you at six');
    expect(threadPreview(null, 'me')).toBe('No messages yet');
  });

  it('flattens line breaks and cuts a long message', () => {
    const long = { ...base, senderId: 'them', body: `line one\nline two ${'x'.repeat(200)}` };
    const preview = threadPreview(long, 'me');
    expect(preview.startsWith('line one line two')).toBe(true);
    expect(preview.length).toBeLessThanOrEqual(81);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('shows a withdrawn message as withdrawn', () => {
    expect(threadPreview({ ...base, body: null, deletedAt: base.createdAt }, 'me')).toBe(
      'Message removed',
    );
  });
});

describe('otherParty', () => {
  const thread = {
    role: 'COACH',
    coach: { id: 'c', firstName: 'Ana', lastName: 'Reyes', avatarUrl: null },
    member: { id: 'm', firstName: 'Ben', lastName: 'Cruz', avatarUrl: null },
  } as ChatThreadView;

  it('is the member for the coach, and the coach for the member', () => {
    expect(otherParty(thread).firstName).toBe('Ben');
    expect(otherParty({ ...thread, role: 'MEMBER' }).firstName).toBe('Ana');
  });
});
