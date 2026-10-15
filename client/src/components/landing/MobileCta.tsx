'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

/**
 * Sticky join bar for narrow screens.
 *
 * On mobile the nav's JOIN button scrolls away and never comes back
 * until the footer. This keeps the primary action one thumb-reach away
 * for the whole page. Appears once the hero is behind you so it never
 * competes with the hero's own CTA.
 */
export default function MobileCta() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const onScroll = () => setVisible(window.scrollY > window.innerHeight * 0.75);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <div className="mobile-cta" data-visible={visible ? 'true' : 'false'}>
      <div style={{ lineHeight: 1.25 }}>
        <div
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 800,
            fontSize: 17,
            color: 'var(--text)',
          }}
        >
          ₱800
          <span style={{ fontSize: 11, color: 'var(--text-3)', fontWeight: 500 }}> / month</span>
        </div>
        <div
          style={{
            fontSize: 10.5,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            color: 'var(--gold)',
          }}
        >
          No lock-in
        </div>
      </div>

      <Link
        id="mobile-join-btn"
        href="/register"
        className="btn btn-gold"
        style={{ padding: '13px 26px', fontSize: 13.5, letterSpacing: '0.1em' }}
      >
        JOIN NOW
      </Link>
    </div>
  );
}
