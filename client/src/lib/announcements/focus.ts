/**
 * The dashboard's `?notice=` deep link — how the bell hands a notice over.
 *
 * Reading happens on the dashboard (owner decision): a row in the bell, or its
 * "View all", navigates there, and the dashboard expands and scrolls to the
 * notice. The param is parsed strictly because it becomes a DOM id and a
 * request path — anything that is not "all" or a UUID is ignored.
 *
 * WHICH dashboard depends on the surface: the member portal's, or the
 * console's, which has the same bell and noticeboard. The base is passed in —
 * `AnnouncementsProvider` carries it — so a link clicked in the console never
 * hands staff across to the member portal.
 */
export type NoticeFocus = 'all' | { kind: 'notice'; id: string };

/** The member portal's noticeboard, and the default base. */
export const PORTAL_NOTICES_HOME = '/portal/dashboard';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const ALL_NOTICES_HREF = `${PORTAL_NOTICES_HOME}?notice=all`;

export function parseNoticeFocus(param: string | null): NoticeFocus | null {
  if (param === null) return null;
  if (param === 'all') return 'all';
  return UUID.test(param) ? { kind: 'notice', id: param.toLowerCase() } : null;
}

export function noticeHref(id: string, home: string = PORTAL_NOTICES_HOME): string {
  return `${home}?notice=${id}`;
}

export function allNoticesHref(home: string = PORTAL_NOTICES_HOME): string {
  return `${home}?notice=all`;
}

export function noticeDomId(id: string): string {
  return `notice-${id}`;
}
