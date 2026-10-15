import { describe, expect, it } from 'vitest';
import { activeHref } from './navActive';

const rows = (...hrefs: string[]) => hrefs.map((href) => ({ href }));

describe('activeHref', () => {
  it('lights exactly one row when one href is a prefix of another', () => {
    const nav = rows('/portal/coaching', '/portal/coaching/clients', '/portal/coaching/messages');
    expect(activeHref('/portal/coaching/clients', nav)).toBe('/portal/coaching/clients');
    expect(activeHref('/portal/coaching/messages', nav)).toBe('/portal/coaching/messages');
    expect(activeHref('/portal/coaching', nav)).toBe('/portal/coaching');
  });

  it('keeps a detail page under its parent', () => {
    expect(activeHref('/portal/workouts/abc', rows('/portal/dashboard', '/portal/workouts'))).toBe(
      '/portal/workouts',
    );
  });

  it('lets a row claim another root through activeFor', () => {
    const nav = [
      { href: '/portal/dashboard' },
      { href: '/portal/coaching/clients', activeFor: ['/portal/coaching/members'] },
      { href: '/portal/coaching/messages' },
    ];
    expect(activeHref('/portal/coaching/members/u1', nav)).toBe('/portal/coaching/clients');
    expect(activeHref('/portal/coaching/messages', nav)).toBe('/portal/coaching/messages');
  });

  it('does not match a sibling that merely shares a string prefix', () => {
    expect(activeHref('/portal/checkins', rows('/portal/checkin'))).toBeNull();
  });

  it('never lights a surface root for a page beneath it', () => {
    const tabs = rows('/admin', '/admin/members', '/admin/attendance');
    expect(activeHref('/admin', tabs)).toBe('/admin');
    expect(activeHref('/admin/payments', tabs)).toBeNull();
    expect(activeHref('/admin/members/u1', tabs)).toBe('/admin/members');
  });

  it('returns null when nothing matches', () => {
    expect(activeHref('/elsewhere', rows('/portal/dashboard'))).toBeNull();
  });
});
