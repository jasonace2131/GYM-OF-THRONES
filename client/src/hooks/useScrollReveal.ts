'use client';

import { useEffect } from 'react';

/**
 * Installs a single page-wide reveal observer.
 *
 * Call this ONCE near the root. Any element carrying the `.rv` class —
 * including ones mounted later — fades up as it enters the viewport.
 * Siblings are staggered automatically via the `--d` delay custom
 * property, so a row of cards deals in like a hand rather than
 * appearing all at once.
 */
export function useScrollReveal() {
  useEffect(() => {
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add('in');
            io.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.08, rootMargin: '0px 0px -8% 0px' },
    );

    const scan = () => {
      document.querySelectorAll<HTMLElement>('.rv:not(.in)').forEach((el) => {
        if (el.dataset['rvBound']) return;
        el.dataset['rvBound'] = '1';

        // Stagger against siblings unless the component set its own delay.
        if (!el.style.getPropertyValue('--d')) {
          const siblings = el.parentElement ? Array.from(el.parentElement.children) : [];
          const index = siblings.indexOf(el);
          el.style.setProperty('--d', `${Math.min(Math.max(index, 0), 3) * 45}ms`);
        }

        io.observe(el);
      });
    };

    scan();

    // Catch elements added after mount (route switches, lazy sections).
    const mo = new MutationObserver(scan);
    mo.observe(document.body, { childList: true, subtree: true });

    // Safety net: never leave content invisible if the observer misfires.
    const fallback = window.setTimeout(() => {
      document.querySelectorAll('.rv:not(.in)').forEach((el) => el.classList.add('in'));
    }, 1500);

    return () => {
      io.disconnect();
      mo.disconnect();
      window.clearTimeout(fallback);
    };
  }, []);
}
