import { PERMISSIONS } from '@got/shared';
import { filterNavItems } from '@/lib/rbac/nav';
import type { PermissionSet } from '@/lib/rbac/permissions';

/**
 * The Reports module's tabs.
 *
 * Revenue used to be its own screen; it is now the last tab here, behind
 * `revenue.read` (ADMIN only). Every tab shares one date range. The front
 * desk keeps the other three exactly as they were (owner decision,
 * 2026-09-25), and `/admin/revenue` redirects to `?tab=revenue`.
 */
export type ReportTab = 'attendance' | 'memberships' | 'walk-ins' | 'revenue';

export interface ReportTabDef {
  key: ReportTab;
  label: string;
  permission?: string;
}

export const REPORT_TABS: readonly ReportTabDef[] = [
  { key: 'attendance', label: 'Attendance' },
  { key: 'memberships', label: 'Memberships' },
  { key: 'walk-ins', label: 'Walk-ins' },
  { key: 'revenue', label: 'Revenue', permission: PERMISSIONS.REVENUE_READ },
];

const BASE = '/admin/reports';

/** The tabs this caller can open, in order. The ungated three always show. */
export function visibleReportTabs(permissions: PermissionSet): ReportTabDef[] {
  return filterNavItems(REPORT_TABS, permissions, 'ALL');
}

/**
 * Which tab `?tab=` opens. A tab the caller lacks — a desk bookmark to the
 * old Revenue screen, say — opens the first tab rather than an empty panel.
 */
export function resolveReportTab(param: string | null, visible: readonly ReportTabDef[]): ReportTab {
  const match = visible.find((tab) => tab.key === param);
  return match?.key ?? visible[0]?.key ?? 'attendance';
}

export function reportTabHref(tab: ReportTab): string {
  return tab === REPORT_TABS[0]?.key ? BASE : `${BASE}?tab=${tab}`;
}
