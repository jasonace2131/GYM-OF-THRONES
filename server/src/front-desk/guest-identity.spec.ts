import { requireGuestIdentity } from './guest-identity';

describe('requireGuestIdentity', () => {
  it('passes a guest with a name and an email', () => {
    expect(() =>
      requireGuestIdentity({ guestName: 'Ana Cruz', guestEmail: 'ana@example.com' }),
    ).not.toThrow();
  });

  it('asks nothing of an existing member — their account already has both', () => {
    expect(() =>
      requireGuestIdentity({ userId: '11111111-1111-4111-8111-111111111111' }),
    ).not.toThrow();
  });

  it('refuses a guest with no name, as GUEST_NAME_REQUIRED (422)', () => {
    expect(() => requireGuestIdentity({ guestEmail: 'ana@example.com' })).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'GUEST_NAME_REQUIRED' }),
        status: 422,
      }),
    );
  });

  it('refuses a guest with no email, as GUEST_EMAIL_REQUIRED (422)', () => {
    expect(() => requireGuestIdentity({ guestName: 'Ana Cruz' })).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'GUEST_EMAIL_REQUIRED' }),
        status: 422,
      }),
    );
  });

  it('checks the name first when both are missing', () => {
    expect(() => requireGuestIdentity({})).toThrow(
      expect.objectContaining({
        response: expect.objectContaining({ code: 'GUEST_NAME_REQUIRED' }),
      }),
    );
  });
});
