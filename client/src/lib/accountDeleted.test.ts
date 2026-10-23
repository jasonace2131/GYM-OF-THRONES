import { afterEach, describe, expect, it } from 'vitest';
import { ACCOUNT_DELETED_FLAG, accountJustDeleted } from './accountDeleted';

describe('accountJustDeleted', () => {
  afterEach(() => window.sessionStorage.clear());

  it('is false normally, so the shell still sends a signed-out visitor to /login', () => {
    expect(accountJustDeleted()).toBe(false);
  });

  it('is true once My account has set the flag, and does not consume it', () => {
    window.sessionStorage.setItem(ACCOUNT_DELETED_FLAG, '1');
    expect(accountJustDeleted()).toBe(true);
    expect(accountJustDeleted()).toBe(true);
  });
});
