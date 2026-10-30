import { describe, expect, it } from 'vitest';
import { handlesSignInItself, loginCodeRedirectFor } from './loginCodeRedirect';

describe('loginCodeRedirectFor', () => {
  it('sends a portal page to /login with the page and its query as next', () => {
    expect(loginCodeRedirectFor('/portal/bookings', '?tab=past')).toBe(
      '/login?next=%2Fportal%2Fbookings%3Ftab%3Dpast',
    );
  });

  it('sends the console and the desk too', () => {
    expect(loginCodeRedirectFor('/admin/members', '')).toBe('/login?next=%2Fadmin%2Fmembers');
    expect(loginCodeRedirectFor('/desk/station', '')).toBe('/login?next=%2Fdesk%2Fstation');
  });

  it.each([
    ['/login', ''],
    ['/login', '?next=%2Fadmin'],
    ['/join/abc123', ''],
    ['/reset-password', ''],
    ['/register', ''],
    ['/', ''],
    ['/', '?ref=ig'],
  ])('leaves %s%s alone — that page handles the code itself', (pathname, search) => {
    expect(loginCodeRedirectFor(pathname, search)).toBeNull();
  });

  it('sends a staff invitation to /login and back — /invite is an allowed next', () => {
    expect(loginCodeRedirectFor('/invite/xyz', '')).toBe('/login?next=%2Finvite%2Fxyz');
  });

  it('the landing page is exact — its sections are not exempt by accident', () => {
    expect(loginCodeRedirectFor('/portal', '')).toBe('/login?next=%2Fportal');
  });

  it('matches whole path segments, not prefixes', () => {
    expect(loginCodeRedirectFor('/loginhelp', '')).toBe('/login?next=%2Floginhelp');
  });
});

describe('handlesSignInItself', () => {
  it('is the same list loginCodeRedirectFor exempts', () => {
    for (const pathname of ['/login', '/join/abc', '/reset-password', '/register', '/']) {
      expect(handlesSignInItself(pathname)).toBe(true);
    }
    for (const pathname of ['/portal', '/admin/members', '/desk/station', '/invite/xyz']) {
      expect(handlesSignInItself(pathname)).toBe(false);
    }
  });
});
