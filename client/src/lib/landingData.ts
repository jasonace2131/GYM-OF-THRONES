/**
 * Static data constants for the landing page.
 * When API integration is ready, swap these out for API calls.
 */

export const STATS = [
  { value: 340, suffix: '+', label: 'Active members' },
  { value: 18, suffix: 'h', label: 'Open daily' },
  { value: 4, suffix: '+', label: 'Certified coaches' },
  { value: 7, suffix: '', label: 'Days a week' },
] as const;

/**
 * Ticker strip under the hero. Keep entries short — they scroll.
 *
 * NO OPENING HOURS HERE. This used to read "Open 5AM – 11PM" while the door
 * shut at 22:00. A scrolling marquee cannot carry a per-weekday summary, and
 * a single hardcoded line is exactly the claim that sent somebody to a locked
 * door — so the hours live in the contact tiles and the footer, which read
 * them from the same table the gate does.
 */
export const TICKER = [
  'Where champions train',
  'No lock-in contracts',
  'Free first assessment',
  'GCash & counter payments',
  'Metro Manila',
  'Est. 2023',
] as const;

export const SERVICES = [
  {
    no: '01',
    title: 'Personal Training',
    body: 'One-on-one coaching with certified trainers, programmed around your goals and your schedule.',
    img: '/assets/gym-d.webp',
    meta: 'From ₱500 / session',
  },
  {
    no: '02',
    title: 'Group Classes',
    body: 'High-energy sessions that scale to every level — you push harder when the room pushes with you.',
    img: '/assets/gym-f.webp',
    meta: 'Included with every monthly or longer plan',
  },
  {
    no: '03',
    title: 'Strength Training',
    body: 'Full free-weight floor: barbells, racks, plates and resistance machines with room to actually lift.',
    img: '/assets/gym-a.webp',
    meta: 'Open floor access',
  },
  {
    no: '04',
    title: 'Cardio Zone',
    body: 'Modern treadmills, bikes and rowers in a dedicated conditioning area away from the weights floor.',
    img: '/assets/gym-c.webp',
    meta: 'Never a queue',
  },
] as const;

/**
 * Plan pricing.
 *
 * `perMonth` and `saves` are computed against the ₱800 monthly rate so
 * every number shown on the page is arithmetically true:
 *   Quarterly  ₱2,200 → ₱733/mo, saves ₱200 vs 3 × ₱800
 *   Annual     ₱7,500 → ₱625/mo, saves ₱2,100 vs 12 × ₱800
 */
/**
 * One card in the pricing grid.
 *
 * Exported as a type because `livePlans.ts` now maps the live `GET /plans`
 * response into this same shape — the constant below is the FALLBACK for an
 * unreachable API, not the source of truth it used to be.
 */
export interface LandingPlan {
  id: string;
  name: string;
  tier: string;
  price: string;
  unit: string;
  perMonth: string | null;
  saves: string | null;
  featured: boolean;
  badge: string | null;
  perks: string[];
}

export const PLANS: LandingPlan[] = [
  {
    id: 'walkin',
    name: 'Walk-in',
    tier: 'Try the floor',
    price: '₱90',
    unit: 'per session',
    perMonth: null,
    saves: null,
    featured: false,
    badge: null,
    perks: ['Full gym floor access', 'Zero commitment', 'Pay at the door'],
  },
  {
    id: 'monthly',
    name: 'Monthly',
    tier: 'Most flexible',
    price: '₱800',
    unit: 'per month',
    perMonth: null,
    saves: null,
    featured: true,
    badge: 'Most popular',
    perks: [
      'Unlimited gym access',
      'All group classes included',
      'Locker & shower access',
      'Free progress reassessment',
    ],
  },
  {
    id: 'quarterly',
    name: 'Quarterly',
    tier: '3 months upfront',
    price: '₱2,200',
    unit: 'per quarter',
    perMonth: '₱733 / mo',
    saves: 'Save ₱200',
    featured: false,
    badge: null,
    perks: ['Everything in Monthly', '1 free PT session', 'Priority class booking'],
  },
  {
    id: 'annual',
    name: 'Annual',
    tier: 'Best value',
    price: '₱7,500',
    unit: 'per year',
    perMonth: '₱625 / mo',
    saves: 'Save ₱2,100',
    featured: false,
    badge: 'Best value',
    perks: ['Everything in Quarterly', '2 guest passes / month', 'Free member tee'],
  },
] as const;

/**
 * The gym's real details, from the owner.
 *
 * These were invented placeholders — "742 Fitness Boulevard", "(02)
 * 8123-4567", "info@gymofthrones.com" — sitting on a live marketing site
 * whose whole job is telling somebody how to reach you. `href` is new: the
 * tiles were plain text, so tapping the phone number on a phone did nothing.
 *
 * NOTE the floor. It is a 4th-floor unit, not a street-level building, and a
 * visitor who does not know that walks into a lobby and gives up.
 */
/**
 * The gym's location, for the map and the "open in Maps" link.
 *
 * A search query rather than latitude/longitude on purpose: coordinates would
 * drop a pin on a roof with no name attached, and somebody standing outside
 * needs the BUILDING, which is what they will ask a guard or a driver for.
 */
export const GYM_LOCATION = {
  query: 'JWMGI Building, Taguig City, Philippines',
  /** Shown under the map. The floor is the part people actually get wrong. */
  directions:
    'We are on the 4th floor take the lift and turn right. Ask the lobby guard for Gym of Thrones if you cannot find it.',
} as const;

export const CONTACT_ITEMS = [
  {
    label: 'Address',
    value: '4th Floor, JWMGI Building\nTaguig City, Philippines 1630',
    href: null,
  },
  { label: 'Phone', value: '0966 205 9526', href: 'tel:+639662059526' },
  {
    label: 'Email',
    value: 'gymofthrones2023@gmail.com',
    href: 'mailto:gymofthrones2023@gmail.com',
  },
  {
    label: 'Instagram',
    value: '@gymofthronesph',
    href: 'https://instagram.com/gymofthronesph',
  },
] as const;

/** Gallery mosaic — full-bleed, so it needs explicit span metadata. */
export const GALLERY = [
  { src: '/assets/reception.webp', alt: 'Reception area', span: 'tall' },
  { src: '/assets/gym-c.webp', alt: 'Cardio zone', span: 'wide' },
  { src: '/assets/gym-f.webp', alt: 'Group class area', span: 'unit' },
  { src: '/assets/gym-a.webp', alt: 'Free weights floor', span: 'unit' },
  { src: '/assets/gym-d.webp', alt: 'Training area', span: 'unit' },
  { src: '/assets/gym-b.webp', alt: 'Resistance machines', span: 'unit' },
] as const;
