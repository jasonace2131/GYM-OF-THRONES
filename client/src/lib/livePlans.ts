import { PLANS, type LandingPlan } from './landingData';
import { API_URL } from './apiBase';

/**
 * The `GET /plans` row, mirroring `server/src/catalogue/plan.presenter.ts`.
 *
 * Declared here rather than imported from `@got/shared` because the server's
 * `PublicPlan` is not exported through that barrel — and the marketing page
 * consuming a public endpoint is exactly the case where a local mirror is
 * honest: it documents what this page depends on, and it is one file to fix
 * if the endpoint changes.
 */
interface PublicPlan {
  code: string;
  name: string;
  description: string | null;
  kind: string;
  priceCentavos: number;
  termMonths: number | null;
  freezable: boolean;
  guestPassesPerTerm: number;
  graceDays: number;
  perks: string[];
  sortOrder: number;
}

/**
 * The pricing grid, from the database rather than from a constant.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE OTHER HALF OF "I CAN'T CHANGE MY PRICES".
 *
 * `GET /plans` is `@Public()` for exactly this — its controller says so:
 * "the pricing grid is the marketing site's front page and must render before
 * anyone has an account." Nothing ever called it. `MembershipSection`
 * rendered `PLANS` from `landingData.ts`, so changing a price in the CRM
 * updated the sale screens and left the marketing site advertising the old
 * figure indefinitely — the worst possible split, because the number a
 * customer decides on is the one that is wrong.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * The hard-coded list is kept as a FALLBACK, not as the source. If the API is
 * unreachable the page still renders a plausible grid rather than an empty
 * section — a marketing page that shows nothing converts worse than one
 * showing a slightly stale price, and the CTA leads to the counter either way.
 */

/** Presentation the API does not carry: badges, ordering emphasis, tier copy. */
const PRESENTATION: Record<string, Pick<LandingPlan, 'tier' | 'badge' | 'featured'>> = {
  WALKIN: { tier: 'Try the floor', badge: null, featured: false },
  MONTHLY: { tier: 'Most flexible', badge: null, featured: false },
  QUARTERLY: { tier: 'Best balance', badge: 'POPULAR', featured: true },
  ANNUAL: { tier: 'Best value', badge: null, featured: false },
};

/** ₱1,234 — no decimals, because every plan price is a whole peso today. */
function peso(centavos: number): string {
  return `₱${Math.round(centavos / 100).toLocaleString('en-PH')}`;
}

function toLandingPlan(plan: PublicPlan): LandingPlan {
  const presentation = PRESENTATION[plan.code] ?? { tier: '', badge: null, featured: false };
  const months = plan.termMonths;

  // "₱733 / month" under a quarterly price. Computed rather than stored, so a
  // price edit cannot leave the headline and the small print disagreeing.
  const perMonth =
    months !== null && months > 1 ? `${peso(plan.priceCentavos / months)} / month` : null;

  return {
    id: plan.code.toLowerCase(),
    name: plan.name,
    tier: presentation.tier,
    price: peso(plan.priceCentavos),
    unit: months === null ? 'per session' : months === 1 ? 'per month' : `per ${months} months`,
    perMonth,
    saves: null,
    featured: presentation.featured,
    badge: presentation.badge,
    perks: plan.perks.length > 0 ? plan.perks : ['Full gym floor access'],
  };
}

/**
 * Fetched on the server at build/request time — this is a marketing page, so
 * the price must be in the HTML for anyone who reads it without running JS,
 * and for the crawler that decides what the page is about.
 *
 * `no-store` rather than a revalidate window: a price change must show up on
 * the next page load, not up to an hour later. This page is cheap and the
 * endpoint is a single indexed read.
 */
export async function fetchLandingPlans(): Promise<LandingPlan[]> {
  try {
    const response = await fetch(`${API_URL}/plans`, { cache: 'no-store' });
    if (!response.ok) return PLANS;

    const body = (await response.json()) as { success: boolean; data: PublicPlan[] };
    if (!body.success || !Array.isArray(body.data) || body.data.length === 0) return PLANS;

    return body.data.map(toLandingPlan);
  } catch {
    // Unreachable API, DNS failure, a build running with no server up. The
    // landing page is the last thing that should hard-fail on any of those.
    return PLANS;
  }
}


/** One weekday, as `GET /config/hours` returns it. */
interface DayHours {
  dayOfWeek: number;
  opensAt: string;
  closesAt: string;
  isClosed: boolean;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** '05:00' → '5AM', '22:00' → '10PM', '17:30' → '5:30PM'. */
function clock(value: string): string {
  const [h, m] = value.split(':').map(Number);
  const hour = h ?? 0;
  const suffix = hour < 12 ? 'AM' : 'PM';
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return m === 0 ? `${twelve}${suffix}` : `${twelve}:${String(m).padStart(2, '0')}${suffix}`;
}

/**
 * The week collapsed into the shortest true sentence.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THREE PLACES ON THIS SITE STATED HOURS AND ALL THREE WERE WRONG.
 *
 * The ticker said 5AM–11PM, the gallery caption said 5AM–11PM, the footer
 * said weekdays 5AM–11PM and weekends 6AM–9PM — while the door shut at 22:00.
 * A member arriving at 22:30 was refused by a system whose own marketing had
 * told them to come. Every one of those strings now derives from the same
 * table the gate reads.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Runs of identical days are merged, so a gym open the same hours all week
 * reads "Daily · 5AM–10PM" rather than seven identical lines nobody scans.
 */
export function summariseHours(week: DayHours[]): string[] {
  if (week.length === 0) return [];

  // Monday-first, because a week that starts on Sunday reads as an American
  // calendar to a Philippine audience.
  const ordered = [1, 2, 3, 4, 5, 6, 0]
    .map((day) => week.find((row) => row.dayOfWeek === day))
    .filter((row): row is DayHours => row !== undefined);

  const label = (row: DayHours): string =>
    row.isClosed ? 'Closed' : `${clock(row.opensAt)} – ${clock(row.closesAt)}`;

  const groups: { from: DayHours; to: DayHours; text: string }[] = [];
  for (const row of ordered) {
    const text = label(row);
    const last = groups[groups.length - 1];
    if (last !== undefined && last.text === text) last.to = row;
    else groups.push({ from: row, to: row, text });
  }

  if (groups.length === 1) return [`Daily · ${groups[0]!.text}`];

  return groups.map((group) => {
    const from = DAY_NAMES[group.from.dayOfWeek];
    const to = DAY_NAMES[group.to.dayOfWeek];
    return `${from === to ? from : `${from}–${to}`} · ${group.text}`;
  });
}

/**
 * Live hours for the marketing page, with the same fallback discipline as the
 * prices: an unreachable API renders a plausible page rather than an empty one.
 */
export async function fetchGymHours(): Promise<string[]> {
  try {
    const response = await fetch(`${API_URL}/config/hours`, { cache: 'no-store' });
    if (!response.ok) return [];

    const body = (await response.json()) as { success: boolean; data: DayHours[] };
    if (!body.success || !Array.isArray(body.data)) return [];

    return summariseHours(body.data);
  } catch {
    // Empty rather than a guess: a wrong opening time on a marketing page is
    // what sent somebody to a locked door in the first place.
    return [];
  }
}
