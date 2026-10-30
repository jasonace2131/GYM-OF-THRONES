'use client';

import { useEffect, useRef, useState } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { supabase } from '@/lib/supabase';
import { apiFetch } from '@/lib/api';
import { type HeldPermission, destinationFor, isStaff } from '@/lib/safeNext';

const LINKS = [
  { label: 'Services', href: '#services' },
  { label: 'Membership', href: '#membership' },
  { label: 'The Floor', href: '#floor' },
  { label: 'Visit', href: '#contact' },
] as const;

/**
 * The header's account button. `null` = no session: "Log in".
 *
 * A signed-in visitor used to see "Log in" here too, and the login page asked
 * them for their password AND a new emailed code (owner bug, 2026-10-23). With
 * a session, the button leads back in instead: labelled from `/me` and routed
 * by the same `destinationFor` the login page uses. Until `/me` answers — or
 * when it cannot, e.g. a sign-in still owed its code — it is "Continue" to
 * /login, which routes a verified session onward and shows the code step for
 * an unverified one. (`/` is exempt from apiFetch's code redirect, so a
 * half-finished sign-in is never pulled off the homepage by this call.)
 */
interface AccountLink {
  href: string;
  label: 'My portal' | 'Staff console' | 'Continue';
}

const CONTINUE: AccountLink = { href: '/login', label: 'Continue' };

function useAccountLink(): AccountLink | null {
  const [account, setAccount] = useState<AccountLink | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const { data } = await supabase.auth.getSession();
        if (cancelled || !data.session) return;
        setAccount(CONTINUE);
        const me = await apiFetch<{ permissions: HeldPermission[] }>('/me');
        if (cancelled) return;
        setAccount({
          href: destinationFor(null, me.permissions),
          label: isStaff(me.permissions) ? 'Staff console' : 'My portal',
        });
      } catch {
        // Keep whatever is showing: "Continue" to /login sorts it out there.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return account;
}

export default function Navbar() {
  const headerRef = useRef<HTMLElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const account = useAccountLink();

  useEffect(() => {
    const header = headerRef.current;
    if (!header) return;

    const updateNav = () => {
      const scrolled = window.scrollY > 40;
      header.classList.toggle('scrolled', scrolled);
      header.classList.toggle('top', !scrolled);
    };

    updateNav();
    window.addEventListener('scroll', updateNav, { passive: true });
    return () => window.removeEventListener('scroll', updateNav);
  }, []);

  // Escape closes it, and the page behind stops scrolling while it is open —
  // without the lock, a thumb drag on the overlay scrolls the page underneath
  // and the menu appears frozen.
  useEffect(() => {
    if (!menuOpen) return;

    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenuOpen(false);
    };

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKey);

    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  return (
    <header
      ref={headerRef}
      className="site-nav top"
      style={{
        position: 'sticky',
        top: 0,
        zIndex: 40,
        borderBottom: '1px solid transparent',
      }}
    >
      <div
        className="wrap"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 28,
          height: 74,
        }}
      >
        {/* Brand */}
        <Link
          href="/"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginRight: 'auto',
            cursor: 'pointer',
            background: 'none',
            border: 'none',
            padding: 0,
          }}
        >
          <Image
            src="/assets/logo.webp"
            alt="Gym of Thrones"
            width={42}
            height={42}
            style={{
              borderRadius: '50%',
              objectFit: 'cover',
              border: '1.5px solid rgba(201,146,42,.55)',
              boxShadow: '0 0 20px rgba(201,146,42,.28)',
            }}
          />
          <span style={{ textAlign: 'left', display: 'block' }}>
            <span
              style={{
                display: 'block',
                fontFamily: 'var(--font-heading)',
                fontWeight: 700,
                fontSize: 16.5,
                letterSpacing: '0.07em',
                color: 'var(--text)',
              }}
            >
              GYM OF THRONES
            </span>
            <span
              className="hide-mobile"
              style={{
                display: 'block',
                fontSize: 9,
                letterSpacing: '0.24em',
                textTransform: 'uppercase',
                color: 'var(--text-3)',
                marginTop: 1,
              }}
            >
              House of Fitness · Est 2023
            </span>
          </span>
        </Link>

        <nav style={{ display: 'flex', gap: 30 }} className="hide-mobile">
          {LINKS.map((link) => (
            <a key={link.label} href={link.href} className="nlink">
              {link.label}
            </a>
          ))}
        </nav>

        <div style={{ display: 'flex', gap: 10, flex: 'none', alignItems: 'center' }}>
          <Link
            href={account?.href ?? '/login'}
            className="btn btn-ghost nav-login"
            style={{ fontSize: 12.5, letterSpacing: '0.1em', padding: '9px 20px' }}
          >
            {account === null ? 'LOGIN' : account.label.toUpperCase()}
          </Link>
          <Link
            href="/register"
            className="btn btn-gold"
            style={{ fontSize: 12.5, letterSpacing: '0.1em', padding: '10px 24px' }}
          >
            JOIN NOW
          </Link>

          {/* Shown only under 900px. Without it the section links simply
              vanished on a phone and the landing page had no navigation at
              all — the visitor could reach nothing but the hero. */}
          <button
            type="button"
            className="nav-burger"
            aria-label={menuOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={menuOpen}
            aria-controls="site-menu"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden data-open={menuOpen} />
            <span aria-hidden data-open={menuOpen} />
          </button>
        </div>
      </div>

      <div
        id="site-menu"
        className="nav-menu"
        data-open={menuOpen}
        // `inert` rather than only visually hiding it: a closed menu must not
        // be reachable by tab or readable by a screen reader.
        {...(menuOpen ? {} : { inert: '' as unknown as boolean })}
      >
        {LINKS.map((link) => (
          <a key={link.label} href={link.href} onClick={() => setMenuOpen(false)}>
            {link.label}
          </a>
        ))}
        <Link
          href={account?.href ?? '/login'}
          className="nav-menu-login"
          onClick={() => setMenuOpen(false)}
        >
          {account === null ? 'Log in' : account.label}
        </Link>
      </div>
    </header>
  );
}
