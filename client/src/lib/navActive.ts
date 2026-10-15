/** A nav row as far as highlighting is concerned. */
export interface ActiveTarget {
  href: string;
  /**
   * Other path roots this row owns. A client's page lives at
   * `/portal/coaching/members/<id>`, which is not under `/portal/coaching/clients`
   * but is reached from it — so "My Clients" claims it.
   */
  activeFor?: readonly string[];
}

/**
 * A surface root (`/admin`, one segment) matches only itself: every console
 * page lives under it, so as an ancestor it would light the Dashboard row on
 * every page that has no row of its own.
 */
const under = (pathname: string, root: string): boolean =>
  pathname === root || (root.split('/').length > 2 && pathname.startsWith(`${root}/`));

/**
 * Which nav row is "you are here" for a path.
 *
 * The row with the LONGEST matching root wins, and only that one. Lighting
 * every prefix match lit two rows at once: on `/portal/coaching/clients` both
 * "Coach Dashboard" (`/portal/coaching`) and "My Clients" were gold. A detail
 * page still lights its parent, because the parent is then the longest match —
 * `/portal/workouts/abc` is Workouts.
 *
 * Returns the winning row's `href`, or null when nothing matches — no row lit
 * is better than a wrong one.
 */
export function activeHref(pathname: string, targets: readonly ActiveTarget[]): string | null {
  let best: { href: string; length: number } | null = null;
  for (const target of targets) {
    for (const root of [target.href, ...(target.activeFor ?? [])]) {
      if (under(pathname, root) && (best === null || root.length > best.length)) {
        best = { href: target.href, length: root.length };
      }
    }
  }
  return best?.href ?? null;
}
