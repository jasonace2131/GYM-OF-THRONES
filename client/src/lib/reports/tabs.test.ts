import { describe, expect, it } from 'vitest';
import {
  ADMIN_PERMISSIONS,
  DEV_PERMISSIONS,
  FRONT_DESK_PERMISSIONS,
} from '@/lib/rbac/roleFixtures';
import { reportTabHref, resolveReportTab, visibleReportTabs } from './tabs';

const keys = (perms: Parameters<typeof visibleReportTabs>[0]) =>
  visibleReportTabs(perms).map((tab) => tab.key);

/**
 * Reports and Revenue are one module (owner decision, 2026-09-25): tabs
 * Attendance · Memberships · Walk-ins · Revenue, one shared date range. The
 * front desk keeps Reports exactly as it was and never sees Revenue.
 */
describe('report tabs', () => {
  it('gives an admin all four, Revenue last', () => {
    expect(keys(ADMIN_PERMISSIONS)).toEqual(['attendance', 'memberships', 'walk-ins', 'revenue']);
    expect(keys(DEV_PERMISSIONS)).toEqual(['attendance', 'memberships', 'walk-ins', 'revenue']);
  });

  it('gives front desk every tab but Revenue', () => {
    expect(keys(FRONT_DESK_PERMISSIONS)).toEqual(['attendance', 'memberships', 'walk-ins']);
  });

  it('shows no Revenue while /me is loading', () => {
    expect(keys(null)).toEqual(['attendance', 'memberships', 'walk-ins']);
  });
});

describe('resolveReportTab', () => {
  const admin = visibleReportTabs(ADMIN_PERMISSIONS);
  const desk = visibleReportTabs(FRONT_DESK_PERMISSIONS);

  it('honours ?tab= for a tab the caller has', () => {
    expect(resolveReportTab('revenue', admin)).toBe('revenue');
    expect(resolveReportTab('walk-ins', desk)).toBe('walk-ins');
  });

  /**
   * `/admin/revenue` redirects to `?tab=revenue`, so a desk bookmark to the
   * old screen lands here. It gets Reports' first tab, not an empty panel.
   */
  it('falls back to the first tab for a tab the caller lacks', () => {
    expect(resolveReportTab('revenue', desk)).toBe('attendance');
  });

  it('falls back to the first tab for nothing or nonsense', () => {
    expect(resolveReportTab(null, admin)).toBe('attendance');
    expect(resolveReportTab('../admin', admin)).toBe('attendance');
  });
});

describe('reportTabHref', () => {
  it('keeps the first tab at the bare path and names the rest', () => {
    expect(reportTabHref('attendance')).toBe('/admin/reports');
    expect(reportTabHref('revenue')).toBe('/admin/reports?tab=revenue');
    expect(reportTabHref('walk-ins')).toBe('/admin/reports?tab=walk-ins');
  });
});
