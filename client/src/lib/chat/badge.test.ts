import { describe, expect, it } from 'vitest';
import { messagesBadge } from './badge';

describe('messagesBadge', () => {
  it('shows nothing for zero, the number up to nine, then 9+', () => {
    expect(messagesBadge(0)).toEqual({ text: null, spoken: 'no unread messages' });
    expect(messagesBadge(1)).toEqual({ text: '1', spoken: '1 unread message' });
    expect(messagesBadge(12)).toEqual({ text: '9+', spoken: '12 unread messages' });
  });

  it('treats a nonsense count as zero', () => {
    expect(messagesBadge(-3).text).toBeNull();
    expect(messagesBadge(Number.NaN).text).toBeNull();
  });
});
