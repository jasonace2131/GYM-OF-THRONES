/**
 * The planner's glyphs, traced from the mockups. Inline stroke SVGs that
 * inherit `currentColor`, like `components/portal/icons.tsx`; the dumbbell
 * itself is `IconDumbbell` there, shared with the nav.
 */

interface IconProps {
  size?: number;
  strokeWidth?: number;
  className?: string;
}

const base = (size: number, strokeWidth: number, className?: string) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
  className,
});

export const IconSparkle = ({ size = 18, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
  </svg>
);

export const IconSparkles = ({ size = 18, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z" />
    <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z" />
  </svg>
);

export const IconClock = ({ size = 14, strokeWidth = 2, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 7v5l3 2" />
  </svg>
);

export const IconSliders = ({ size = 18, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" />
    <circle cx="16" cy="6" r="2" />
    <circle cx="10" cy="12" r="2" />
    <circle cx="18" cy="18" r="2" />
  </svg>
);

export const IconSwap = ({ size = 15, strokeWidth = 2, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M7 4L3 8l4 4M3 8h14M17 20l4-4-4-4M21 16H7" />
  </svg>
);

export const IconInfo = ({ size = 15, strokeWidth = 2, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5M12 8h.01" />
  </svg>
);

export const IconCheck = ({ size = 16, strokeWidth = 2.4, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const IconShield = ({ size = 16, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z" />
  </svg>
);

export const IconMoon = ({ size = 18, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
  </svg>
);

export const IconFork = ({ size = 17, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M7 3v8M5 3v5a2 2 0 0 0 4 0V3M7 11v10M17 3c-2 0-3 2-3 5s1 4 3 4v9" />
  </svg>
);

export const IconDrop = ({ size = 17, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z" />
  </svg>
);

export const IconHeart = ({ size = 17, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" />
  </svg>
);

export const IconLock = ({ size = 14, strokeWidth = 2, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <rect x="5" y="11" width="14" height="10" rx="2" />
    <path d="M8 11V8a4 4 0 0 1 8 0v3" />
  </svg>
);

export const IconCalendar = ({ size = 18, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <rect x="3" y="5" width="18" height="16" rx="2" />
    <path d="M3 10h18M8 3v4M16 3v4" />
  </svg>
);

export const IconWarning = ({ size = 18, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M12 4l9 16H3z" />
    <path d="M12 10v4M12 17h.01" />
  </svg>
);

export const IconSend = ({ size = 18, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M4 12l16-8-6 16-2.5-6.5z" />
  </svg>
);

export const IconPencil = ({ size = 16, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M4 20h4L19 9l-4-4L4 16z" />
    <path d="M14 6l4 4" />
  </svg>
);

export const IconArrowLeft = ({ size = 18, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M15 18l-6-6 6-6" />
  </svg>
);

export const IconPlus = ({ size = 16, strokeWidth = 2, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconTrash = ({ size = 16, strokeWidth = 1.8, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3" />
  </svg>
);

/** CONTINUE WORKOUT / Start — a filled play triangle (PhoneHubCoach.dc.html). */
export const IconPlay = ({ size = 18, className }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden
    className={className}
  >
    <path d="M8 5.5v13l10.5-6.5z" />
  </svg>
);

/** FROM COACH — a person. */
export const IconPerson = ({ size = 12, strokeWidth = 2.2, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <circle cx="12" cy="8" r="4" />
    <path d="M4 21c0-4.4 3.6-8 8-8s8 3.6 8 8" />
  </svg>
);

/** "Last time …" — a clock turning back. */
export const IconLastTime = ({ size = 13, strokeWidth = 2, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
    <path d="M3 3v5h5M12 7v5l3 2" />
  </svg>
);

/** NEW BEST — a cup. */
export const IconTrophy = ({ size = 20, strokeWidth = 1.9, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M7 4h10v5a5 5 0 0 1-10 0z" />
    <path d="M7 6H4a3 3 0 0 0 3 4M17 6h3a3 3 0 0 1-3 4M12 14v4M8 21h8" />
  </svg>
);

/** Spins under `.wk-spin` unless the member prefers reduced motion. */
export const IconSpinner = ({ size = 18, strokeWidth = 2.4, className }: IconProps) => (
  <svg {...base(size, strokeWidth, className)}>
    <path d="M12 3a9 9 0 1 1-9 9" />
  </svg>
);
