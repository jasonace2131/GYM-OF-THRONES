import { chatBroadcastMessages } from './chat-broadcast';

describe('chatBroadcastMessages', () => {
  const message = {
    id: 'msg-1',
    threadId: 'thread-1',
    senderId: 'user-row-coach',
    body: 'See you at six.',
    createdAt: '2026-09-25T02:00:00.000Z',
    editedAt: null,
    deletedAt: null,
  };

  it("sends one private 'chat.message' to each participant's own channel", () => {
    expect(
      chatBroadcastMessages(['auth-member', 'auth-coach'], {
        threadId: 'thread-1',
        message,
        clientId: 'tmp-1',
      }),
    ).toEqual([
      {
        topic: 'user:auth-member',
        event: 'chat.message',
        payload: { threadId: 'thread-1', message, clientId: 'tmp-1' },
        private: true,
      },
      {
        topic: 'user:auth-coach',
        event: 'chat.message',
        payload: { threadId: 'thread-1', message, clientId: 'tmp-1' },
        private: true,
      },
    ]);
  });

  it('never sends the same channel twice', () => {
    const out = chatBroadcastMessages(['a', 'a', 'b'], {
      threadId: 't',
      message,
      clientId: null,
    });
    expect(out.map((m) => m.topic)).toEqual(['user:a', 'user:b']);
  });
});
