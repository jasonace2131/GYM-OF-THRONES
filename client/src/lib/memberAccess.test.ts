import { describe, expect, it } from 'vitest';
import { visibleNav } from '@/components/portal/nav';
import { CLIENT_PERMISSIONS } from './rbac/roleFixtures';
import { FEATURE_COPY, MEMBERSHIP_NOTICE, RENEW_HREF, memberAccessOf } from './memberAccess';

describe('memberAccessOf', () => {
  it('is unknown (null) while /me is loading', () => {
    expect(memberAccessOf(null)).toBeNull();
  });

  it("is the server's answer when /me carries one", () => {
    expect(memberAccessOf({ memberAccess: 'LOCKED' })).toBe('LOCKED');
    expect(memberAccessOf({ memberAccess: 'READ_ONLY' })).toBe('READ_ONLY');
    expect(memberAccessOf({ memberAccess: 'FULL' })).toBe('FULL');
  });

  it('falls open to FULL against an API that predates the field — the server still gates', () => {
    expect(memberAccessOf({})).toBe('FULL');
  });
});

describe('the copy', () => {
  it("uses the owner's notice word for word", () => {
    expect(MEMBERSHIP_NOTICE).toBe("Your membership isn't active. Renew to keep using this.");
  });

  it('sends both the locked page and the notice to My Subscription', () => {
    expect(RENEW_HREF).toBe('/portal/subscription');
  });

  it('has a title and one line for each gated feature', () => {
    for (const feature of ['workouts', 'assistant', 'progress', 'coach'] as const) {
      expect(FEATURE_COPY[feature].title.length).toBeGreaterThan(0);
      expect(FEATURE_COPY[feature].line.length).toBeGreaterThan(0);
    }
  });
});

describe('the nav', () => {
  // Owner, 2026-10-17: a non-member still SEES the tabs; they open a locked
  // page. The nav is built from permissions only, never from membership.
  it("still shows a member every gated feature's tab", () => {
    const hrefs = visibleNav(CLIENT_PERMISSIONS).flatMap((group) =>
      group.items.map((item) => item.href),
    );
    for (const href of [
      '/portal/workouts',
      '/portal/assistant',
      '/portal/progress',
      '/portal/coach',
    ]) {
      expect(hrefs).toContain(href);
    }
  });
});
