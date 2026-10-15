import { describe, expect, it } from 'vitest';
import {
  ALL_NOTICES_HREF,
  PORTAL_NOTICES_HOME,
  allNoticesHref,
  noticeDomId,
  noticeHref,
  parseNoticeFocus,
} from './focus';

const ID = '3f2b8c1e-9a4d-4c6b-8e21-5d7f0a9b1c23';

describe('parseNoticeFocus', () => {
  it('reads "all"', () => {
    expect(parseNoticeFocus('all')).toBe('all');
  });

  it('reads a notice id', () => {
    expect(parseNoticeFocus(ID)).toEqual({ kind: 'notice', id: ID });
  });

  it('accepts an upper-case UUID and normalises it', () => {
    expect(parseNoticeFocus(ID.toUpperCase())).toEqual({ kind: 'notice', id: ID });
  });

  /**
   * UUID ONLY. The value ends up in a DOM id and a request path; anything
   * that is not a UUID is ignored rather than trusted.
   */
  it('ignores anything that is not "all" or a UUID', () => {
    expect(parseNoticeFocus(null)).toBeNull();
    expect(parseNoticeFocus('')).toBeNull();
    expect(parseNoticeFocus('ALL ')).toBeNull();
    expect(parseNoticeFocus('../admin')).toBeNull();
    expect(parseNoticeFocus(`${ID}x`)).toBeNull();
    expect(parseNoticeFocus('12345')).toBeNull();
  });
});

describe('links', () => {
  it('points at the dashboard', () => {
    expect(noticeHref(ID)).toBe(`/portal/dashboard?notice=${ID}`);
    expect(ALL_NOTICES_HREF).toBe('/portal/dashboard?notice=all');
    expect(allNoticesHref()).toBe(ALL_NOTICES_HREF);
  });

  /**
   * The console has the bell and a noticeboard too, so the same links must
   * land on the CONSOLE dashboard when they are clicked there — never hand
   * staff across to the member portal.
   */
  it('points at whichever dashboard hosts the noticeboard', () => {
    expect(noticeHref(ID, '/admin')).toBe(`/admin?notice=${ID}`);
    expect(allNoticesHref('/admin')).toBe('/admin?notice=all');
    expect(PORTAL_NOTICES_HOME).toBe('/portal/dashboard');
  });

  it('gives each notice a stable DOM id', () => {
    expect(noticeDomId(ID)).toBe(`notice-${ID}`);
  });
});
