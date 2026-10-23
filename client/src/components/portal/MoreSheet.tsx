'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { NavItem } from './nav';
import { IconSignOut } from './icons';
import { NavItemBadge } from '@/components/chat/NavItemBadge';
import { activeHref } from '@/lib/navActive';
import { SignOutButton, type SignOutSurface } from '@/components/auth/ConfirmSignOutDialog';

export interface MoreSheetGroup {
  label?: string;
  items: NavItem[];
}

interface MoreSheetProps {
  open: boolean;
  onClose: () => void;
  groups: MoreSheetGroup[];
  /** Runs once the user CONFIRMS — Sign out asks first, over the sheet. */
  onSignOut: () => void | Promise<void>;
  /** Which surface's confirm button style the dialog uses. */
  surface: SignOutSurface;
  /** The SurfaceSwitch, when this caller holds two surfaces. */
  switchTo?: ReactNode;
}

/**
 * The nav that does not fit in four tabs.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * THE CONSOLE HAD NO NAVIGATION AT ALL BELOW 900px.
 *
 * `portal.css` hides `.p-sidebar` at that width and `admin/layout.tsx`
 * rendered nothing in its place — so a front-desk operator on the counter
 * tablet in portrait, or any staff member on a phone, could reach no screen
 * but the one they were already on, and could not sign out. Meanwhile
 * `.p-content { padding-bottom: 96px }` was reserving room for a tab bar the
 * console never rendered, so the console was already paying the layout cost
 * of the fix without receiving it.
 *
 * Members gain from this too: Sign out has never been reachable on a phone.
 * ─────────────────────────────────────────────────────────────────────────
 */
export function MoreSheet({ open, onClose, groups, onSignOut, surface, switchTo }: MoreSheetProps) {
  const pathname = usePathname();

  // Escape closes, and the body does not scroll behind an open sheet. Both are
  // what `Modal.tsx` already does; this is a sheet rather than a modal only
  // because it is anchored to the bar that opened it.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      // The sign-out confirmation stacks over this sheet; its Escape (Radix
      // marks it handled) cancels the dialog only, not the sheet beneath.
      if (event.key === 'Escape' && !event.defaultPrevented) onClose();
    };
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  // One lit row across every group, the same rule the sidebar follows.
  const current = activeHref(
    pathname,
    groups.flatMap((group) => group.items),
  );

  return (
    <div className="p-sheet-backdrop" onClick={onClose}>
      <div
        className="p-sheet"
        role="dialog"
        aria-modal="true"
        aria-label="More"
        // The backdrop closes; the sheet itself must not, or every tap on a
        // link registers on both.
        onClick={(event) => event.stopPropagation()}
      >
        <div className="p-sheet-grip" aria-hidden />

        <nav className="p-sheet-nav" aria-label="All sections">
          {groups.map((group, index) => (
            <div key={group.label ?? `group-${index}`}>
              {group.label ? <div className="p-nav-group">{group.label}</div> : null}
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = item.href === current;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    className="p-link"
                    data-active={active}
                    aria-current={active ? 'page' : undefined}
                    onClick={onClose}
                  >
                    <Icon />
                    {item.label}
                    <NavItemBadge badge={item.badge} />
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="p-sheet-foot">
          {switchTo}
          <SignOutButton surface={surface} className="p-link" onConfirm={onSignOut}>
            <IconSignOut />
            Sign out
          </SignOutButton>
        </div>
      </div>
    </div>
  );
}
