import type { Metadata, Viewport } from 'next';
import { Outfit, Inter } from 'next/font/google';
import './globals.css';

/**
 * Fonts are self-hosted by next/font rather than pulled in with a CSS
 * `@import`. An @import forced a serial chain before any text could
 * paint: globals.css → fonts.googleapis.com → fonts.gstatic.com. These
 * are emitted as preloaded local files with zero external requests.
 */
const outfit = Outfit({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700', '800'],
  variable: '--font-outfit',
  display: 'swap',
});

const inter = Inter({
  subsets: ['latin'],
  weight: ['300', '400', '500', '600'],
  variable: '--font-inter',
  display: 'swap',
});

/** Dark UA chrome: scrollbars, form controls and the mobile address bar. */
export const viewport: Viewport = {
  themeColor: '#0b0b0d',
  colorScheme: 'dark',
};

/**
 * The site's own origin, for link previews.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WITHOUT THIS, THE PREVIEW IMAGE DOES NOT APPEAR — and nothing warns you
 * loudly about it.
 *
 * `og:image` MUST be an absolute URL. A scraper (Facebook, Messenger, Viber,
 * Slack, iMessage) fetches the page from its own servers and has no idea what
 * "/og.jpg" is relative to. `metadataBase` is what lets Next emit
 * `https://…/og.jpg` instead, so the relative path below resolves.
 *
 * Read from an env var so a preview deployment advertises its own URL rather
 * than production's — Vercel sets VERCEL_URL on every deployment, without the
 * scheme. The literal fallback is the production domain, because a build with
 * neither must still produce working absolute URLs.
 *
 * The fallback was the generated `gym-of-thrones-client.vercel.app` until the
 * gym owned a domain. It is now the real one, so a build that somehow reaches
 * this branch advertises the address on the posters rather than a Vercel
 * subdomain nobody recognises. `NEXT_PUBLIC_SITE_URL` still overrides it and
 * remains the thing to set in Vercel.
 * ─────────────────────────────────────────────────────────────────────────
 */
const SITE_URL = process.env['NEXT_PUBLIC_SITE_URL']
  ? process.env['NEXT_PUBLIC_SITE_URL']
  : process.env['VERCEL_URL']
    ? `https://${process.env['VERCEL_URL']}`
    : 'https://gym-of-thrones.site';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: 'Gym of Thrones — House of Fitness · Est 2023',
  description:
    'Your premier fitness destination in Metro Manila. Equipment, coaching, and community. Join now and take the throne.',
  keywords: ['gym', 'fitness', 'Metro Manila', 'membership', 'personal training', 'Gym of Thrones'],
  openGraph: {
    title: 'Gym of Thrones — House of Fitness',
    description: 'Where Champions Train. Equipment, coaching and community in Metro Manila.',
    type: 'website',
    siteName: 'Gym of Thrones',
    locale: 'en_PH',
    url: '/',
    images: [
      {
        // JPEG, NOT the .webp the rest of the site uses. Facebook's and
        // Messenger's crawlers render JPEG/PNG/GIF; WebP silently produces a
        // card with no image, which looks like the tag is missing entirely.
        //
        // 1200×630 is the 1.91:1 box every platform crops to. Supplying it
        // pre-cropped is the only way to control what stays in frame.
        url: '/og.jpg',
        width: 1200,
        height: 630,
        alt: 'The training floor at Gym of Thrones',
      },
    ],
  },
  twitter: {
    // Without an explicit card type, X renders the small square thumbnail
    // rather than the wide image, and the 1200×630 crop is wasted.
    card: 'summary_large_image',
    title: 'Gym of Thrones — House of Fitness',
    description: 'Where Champions Train. Equipment, coaching and community in Metro Manila.',
    images: ['/og.jpg'],
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${inter.variable}`} suppressHydrationWarning>
      <head>
        {/*
          Marks that scripting is live, before first paint. Scroll-reveal
          elements only hide themselves under `.js`, so if JS is disabled
          or still loading the content renders plainly instead of sitting
          invisible waiting for hydration.
        */}
        <script
          dangerouslySetInnerHTML={{ __html: "document.documentElement.classList.add('js')" }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
