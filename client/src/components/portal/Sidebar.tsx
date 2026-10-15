'use client';

import Image from 'next/image';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { PermissionSet } from '@/lib/rbac/permissions';
import { visibleNav, type NavItem } from './nav';
import { IconMenu, IconSignOut } from './icons';
import { NavItemBadge } from '@/components/chat/NavItemBadge';
import { activeHref } from '@/lib/navActive';

interface SidebarProps {
  onSignOut: () => void;
  /**
   * The caller's own permissions, from the `/me` the shell already fetches.
   *
   * `null` while that is in flight or after it failed. Gated sections stay
   * hidden in both cases — see `visibleNav`. The sections every signed-in
   * person has are ungated and render regardless.
   */
  permissions?: PermissionSet;
}

/**
 * THE "STAFF CONSOLE" LINK THAT USED TO LIVE AT THE BOTTOM OF THIS NAV IS GONE.
 *
 * It was a gold-tinted row after an 18px spacer, between the member's own
 * sections and Sign out — filed as navigation when it was actually a change of
 * surface, present on one side only, and invisible below 900px where the whole
 * sidebar is hidden. It is now `<SurfaceSwitch>` in the topbar of BOTH shells.
 */
export function Sidebar({ onSignOut, permissions = null }: SidebarProps) {
  const pathname = usePathname();
  const groups = visibleNav(permissions);
  const current = activeHref(
    pathname,
    groups.flatMap((group) => group.items),
  );

  return (
    <aside className="p-sidebar">
      <Link href="/" className="p-brand">
        <Image
          src="/assets/logo.webp"
          alt=""
          aria-hidden
          width={34}
          height={34}
          style={{
            borderRadius: '50%',
            objectFit: 'cover',
            border: '1.5px solid rgba(201,146,42,.5)',
            flex: 'none',
          }}
        />
        <span>
          <span className="p-brand-name">GYM OF THRONES</span>
          <span className="p-brand-sub">Member Portal</span>
        </span>
      </Link>

      <nav className="p-nav">
        {groups.map((group) => (
          <div key={group.heading}>
            <div className="p-nav-group">{group.heading}</div>
            {group.items.map((item) => {
              const Icon = item.icon;
              // Exactly one row is lit: the longest href this path sits under
              // (lib/navActive). Child routes keep their parent lit, and a
              // parent no longer lights up alongside its own child row —
              // "My Clients" used to light "Coach Dashboard" too.
              const active = item.href === current;

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className="p-link"
                  data-active={active}
                  // data-active is a paint; aria-current is what a screen
                  // reader announces. The console sets it and this did not.
                  aria-current={active ? 'page' : undefined}
                >
                  <Icon />
                  {item.label}
                  <NavItemBadge badge={item.badge} />
                </Link>
              );
            })}
          </div>
        ))}

        {/* `flex: 1` now does its job — see the .p-nav rule in portal.css. The
            inline minHeight was propping up a spacer that could not grow. */}
        <div className="p-nav-spacer" />

        <button type="button" className="p-link" onClick={onSignOut} style={{ cursor: 'pointer' }}>
          <IconSignOut />
          Sign Out
        </button>
      </nav>
    </aside>
  );
}

interface MobileTabBarProps {
  /**
   * Required, and already filtered for this caller: the portal passes
   * `visibleTabs(permissions)`, the console its own four. There is no
   * unfiltered default, so the bar can never offer a tab the caller's nav
   * would hide.
   */
  items: NavItem[];
  /** Renders a fifth "More" tab. Omit for a bar with no overflow. */
  onMore?: () => void;
  label?: string;
}

/**
 * The bottom bar, now shared by both shells.
 *
 * `grid-auto-columns: 1fr` absorbs four or five columns without a rule
 * change, which is the whole reason the More tab could be added here rather
 * than as a floating button.
 */
export function MobileTabBar({ items, onMore, label = 'Portal sections' }: MobileTabBarProps) {
  const pathname = usePathname();
  const current = activeHref(pathname, items);

  return (
    <nav className="p-tabbar" aria-label={label}>
      {items.map((item) => {
        const Icon = item.icon;
        const active = item.href === current;
        return (
          <Link
            key={item.href}
            href={item.href}
            className="p-tab"
            data-active={active}
            aria-current={active ? 'page' : undefined}
          >
            <Icon size={20} />
            {item.label}
            <NavItemBadge badge={item.badge} />
          </Link>
        );
      })}

      {onMore ? (
        <button type="button" className="p-tab" onClick={onMore}>
          <IconMenu size={20} />
          More
        </button>
      ) : null}
    </nav>
  );
}
