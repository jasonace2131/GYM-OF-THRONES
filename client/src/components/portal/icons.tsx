/**
 * Portal navigation icons.
 *
 * Inline rather than an icon package: fourteen 20px glyphs do not justify a
 * dependency, and inline SVG inherits `currentColor` so active states need no
 * extra wiring.
 */

interface IconProps {
  size?: number;
}

const base = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
});

export const IconDashboard = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="7" height="9" rx="1.5" />
    <rect x="14" y="3" width="7" height="5" rx="1.5" />
    <rect x="14" y="12" width="7" height="9" rx="1.5" />
    <rect x="3" y="16" width="7" height="5" rx="1.5" />
  </svg>
);

/**
 * Workouts (feat/member-workouts). The mockup's dumbbell: two plates a side,
 * one bar — reads at 18px and at the tab bar's 20px without the plates
 * merging into a blob.
 */
export const IconDumbbell = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M6.5 6.5v11M3.5 9v6M17.5 6.5v11M20.5 9v6M6.5 12h11" />
  </svg>
);

export const IconCalendar = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

export const IconHistory = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 12a9 9 0 1 0 3-6.7" />
    <path d="M3 4v5h5M12 7v5l3.5 2" />
  </svg>
);

export const IconCard = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="2.5" y="5" width="19" height="14" rx="2" />
    <path d="M2.5 10h19" />
  </svg>
);

export const IconWallet = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v1" />
    <rect x="3" y="7" width="18" height="12" rx="2" />
    <circle cx="16.5" cy="13" r="1.3" />
  </svg>
);

export const IconChart = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
  </svg>
);

export const IconChat = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M21 12a8 8 0 0 1-8 8H7l-4 3v-4.5A8 8 0 0 1 13 4a8 8 0 0 1 8 8Z" />
  </svg>
);

export const IconMegaphone = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 11v2a1 1 0 0 0 1 1h2l6 4V6L6 10H4a1 1 0 0 0-1 1Z" />
    <path d="M16 9a4 4 0 0 1 0 6M19 6a8 8 0 0 1 0 12" />
  </svg>
);

export const IconUserPlus = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="9" cy="8" r="3.5" />
    <path d="M2.5 20a6.5 6.5 0 0 1 13 0M18 8v6M21 11h-6" />
  </svg>
);

export const IconQr = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <path d="M14 14h3v3h-3zM20 14v.01M20 20v.01M14 20v.01M17 20v.01M20 17v.01" />
  </svg>
);

/** Staff & Access: who works here and what each role may do. */
export const IconShield = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3Z" />
    <path d="M9 12l2 2 4-4" />
  </svg>
);

export const IconSignOut = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M15 17l5-5-5-5M20 12H9M11 20H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5" />
  </svg>
);

export const IconBell = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M18 9a6 6 0 1 0-12 0c0 5-2 6-2 6h16s-2-1-2-6ZM10.5 20a2 2 0 0 0 3 0" />
  </svg>
);

export const IconMenu = ({ size = 20 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 6h18M3 12h18M3 18h18" />
  </svg>
);

export const IconArrow = ({ size = 15 }: IconProps) => (
  <svg {...base(size)} strokeWidth={2.2}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const IconChevronLeft = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} strokeWidth={2.2}>
    <path d="M15 5l-7 7 7 7" />
  </svg>
);

export const IconChevronRight = ({ size = 16 }: IconProps) => (
  <svg {...base(size)} strokeWidth={2.2}>
    <path d="M9 5l7 7-7 7" />
  </svg>
);

export const IconCheck = ({ size = 14 }: IconProps) => (
  <svg {...base(size)} strokeWidth={2.6}>
    <path d="M20 6L9 17l-5-5" />
  </svg>
);

export const IconScan = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M3 8V5a2 2 0 0 1 2-2h3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M8 21H5a2 2 0 0 1-2-2v-3" />
    <path d="M3 12h18" />
  </svg>
);

export const IconFlame = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M12 22a6 6 0 0 0 6-6c0-4-3-5-3-9 0 0-3 1.5-3 5 0-2-2-3-2-3s-4 3-4 7a6 6 0 0 0 6 6Z" />
  </svg>
);

/**
 * Settings. Added because Settings and Classes were BOTH `IconCalendar` — in a
 * console whose sidebar is its only wayfinding, two identical glyphs in one
 * nav is a real cost, and it lands on the bottom tab bar too.
 */
export const IconGear = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09a1.65 1.65 0 0 0-1.08-1.51 1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
  </svg>
);

/**
 * Coaching. A whistle — the one glyph in this set that says "the person
 * running the session" rather than "a person". Distinct from IconUserPlus
 * (bookings) and IconChat (My Coach) at 18px, which is the only size that
 * matters here.
 */
export const IconWhistle = ({ size = 18 }: IconProps) => (
  <svg {...base(size)}>
    <path d="M13 8h6a2 2 0 0 1 2 2v1a6 6 0 0 1-6 6h-3a5 5 0 0 1 0-10h1Z" />
    <circle cx="9" cy="12" r="1.6" />
    <path d="M13 8V5a2 2 0 0 1 2-2h2" />
  </svg>
);
