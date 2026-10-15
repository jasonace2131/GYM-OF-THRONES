'use client';

import { useEffect } from 'react';

/**
 * Makes a warm gold light track the cursor across any `.glow` element.
 *
 * One delegated listener for the whole page rather than a handler per
 * card. Writes `--mx` / `--my` on the hovered element; the radial
 * gradient in `globals.css` does the rest.
 */
export function usePointerGlow() {
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const onMove = (event: PointerEvent) => {
      const target = event.target as Element | null;
      const card = target?.closest?.('.glow') as HTMLElement | null;
      if (!card) return;

      const rect = card.getBoundingClientRect();
      card.style.setProperty('--mx', `${event.clientX - rect.left}px`);
      card.style.setProperty('--my', `${event.clientY - rect.top}px`);
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => window.removeEventListener('pointermove', onMove);
  }, []);
}
