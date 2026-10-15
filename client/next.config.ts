import type { NextConfig } from 'next';
import { upstreamOrigin } from './src/lib/apiBase';

const nextConfig: NextConfig = {
  /**
   * ───────────────────────────────────────────────────────────────────────
   * `/api/*` → the real API, proxied by Vercel. See `src/lib/apiBase.ts`.
   *
   * The browser calls this site's own origin and never learns the API's
   * host. That is what gets members past ISPs that block Render's shared
   * IPs, and it leaves no cross-origin request for CORS to refuse.
   *
   * The upstream is derived from NEXT_PUBLIC_API_URL, the variable Vercel
   * already has, so shipping this needs no dashboard change. It is read at
   * BUILD time, like every rewrite: changing the variable needs a redeploy.
   *
   * A plain array is an `afterFiles` rewrite, so a Next route under /api
   * would win over it. There is none today — `src/app/api` does not exist —
   * and one added later would shadow the proxy for its own path only.
   * ───────────────────────────────────────────────────────────────────────
   */
  async rewrites() {
    const upstream = upstreamOrigin(process.env.NEXT_PUBLIC_API_URL);
    return [{ source: '/api/:path*', destination: `${upstream}/api/:path*` }];
  },

  /**
   * ───────────────────────────────────────────────────────────────────────
   * `/admin/subscriptions` → `/admin/members?sort=ending`. MANDATORY, not a
   * courtesy.
   *
   * `membership-nightly.job.ts` writes `linkPath` into `SystemNotification`
   * rows, and `admin/notifications/page.tsx` renders that STORED STRING as
   * `<Link href={row.linkPath}>`. Rows already in production point at
   * `/admin/subscriptions`, and the job has been changed only for the rows it
   * writes from now on. Without this entry, every "View" button on a
   * pre-merge nightly notification is a 404.
   *
   * A STATIC destination is safe here: the old screen kept zero state in the
   * URL (no `useSearchParams` anywhere in it), so no filtered deep link to it
   * can exist and there is nothing to carry across. `sort=ending` is the
   * order that screen was read in.
   *
   * `permanent: false` (307) on purpose. A 308 is cached by browsers
   * indefinitely and would be very hard to take back if the roster ever
   * splits again.
   * ───────────────────────────────────────────────────────────────────────
   */
  async redirects() {
    return [
      {
        source: '/admin/subscriptions',
        destination: '/admin/members?sort=ending',
        permanent: false,
      },
      /**
       * ─────────────────────────────────────────────────────────────────────
       * `/portal/announcements` → `/portal/dashboard?notice=all`.
       *
       * The member Announcements page is gone: notices are read on the
       * dashboard, and the topbar bell is how new ones are found. Bookmarks,
       * the installed app's history and any link a member was sent still
       * point here, so they land on the dashboard's noticeboard — scrolled to
       * and focused — rather than on a 404.
       *
       * `permanent: false` (307) for the same reason as the entry above: a
       * 308 is cached by browsers indefinitely and would be very hard to take
       * back if the page ever returns.
       * ─────────────────────────────────────────────────────────────────────
       */
      {
        source: '/portal/announcements',
        destination: '/portal/dashboard?notice=all',
        permanent: false,
      },
      /**
       * `/portal/coaching` → `/portal/dashboard`.
       *
       * A coach had two dashboards (owner, 2026-10-06). /portal/dashboard now
       * renders the coach view for a coach, so the old Coach Dashboard URL —
       * bookmarks, sign-in redirects already in flight, bell rows built
       * against it (`?notice=` is carried through: a redirect keeps the query)
       * — lands on the one dashboard. Only the bare path: My Clients,
       * Messages and a client's page all live under it and stay put.
       * `permanent: false` for the reason the entries above give.
       */
      {
        source: '/portal/coaching',
        destination: '/portal/dashboard',
        permanent: false,
      },
      /**
       * ─────────────────────────────────────────────────────────────────────
       * `/admin/revenue` → `/admin/reports?tab=revenue`.
       *
       * Revenue is no longer its own screen: it is the Revenue tab of
       * Reports, behind `revenue.read` (owner decision, 2026-09-25). Staff
       * bookmarks and browser history still point at the old URL, so they
       * land on the tab. A caller without `revenue.read` — the front desk —
       * lands on Reports' first tab instead of an empty panel
       * (`lib/reports/tabs.ts`).
       *
       * `permanent: false` (307) for the same reason as the entries above: a
       * 308 is cached by browsers indefinitely and would be very hard to take
       * back if Revenue ever becomes its own screen again.
       * ─────────────────────────────────────────────────────────────────────
       */
      {
        source: '/admin/revenue',
        destination: '/admin/reports?tab=revenue',
        permanent: false,
      },
    ];
  },

  images: {
    /**
     * Image optimization is ON.
     *
     * It was previously disabled with `unoptimized: true` on the
     * assumption that local /public images don't need it — they do.
     * `unoptimized` turns off resizing and format negotiation entirely,
     * so the browser downloaded every source file at full size. That
     * was the single largest cost on the landing page.
     *
     * With it enabled, Next serves AVIF/WebP at the width each layout
     * slot actually requests (the `sizes` prop on every fill image
     * drives this), so a 682px card never ships a 2048px source.
     */
    formats: ['image/avif', 'image/webp'],
    // Matches the layout: full-bleed hero, half/third-width cards, avatars.
    deviceSizes: [640, 750, 828, 1080, 1200, 1920, 2048],
    imageSizes: [48, 64, 96, 128, 256, 384],
    // Local assets are immutable once built; cache them hard.
    minimumCacheTTL: 60 * 60 * 24 * 365,
  },
};

export default nextConfig;
