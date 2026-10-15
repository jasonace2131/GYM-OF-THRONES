'use client';

import { useEffect } from 'react';

/**
 * Keeps the screen on while the session is open (spec §5). A phone that dims
 * mid-set makes the member unlock it with chalky hands to tick one box.
 *
 * The browser drops the lock whenever the page is hidden, so it is asked for
 * again each time the page is shown. Where the API is missing (older iOS) or
 * refused (low battery), the workout simply runs without it.
 */
export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async (): Promise<void> => {
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (cancelled) {
          void lock.release().catch(() => undefined);
          return;
        }
        sentinel = lock;
      } catch {
        // Refused or unsupported: no lock, no error for the member.
      }
    };

    const onVisibility = (): void => {
      if (document.visibilityState === 'visible' && (sentinel === null || sentinel.released)) {
        void acquire();
      }
    };

    void acquire();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisibility);
      void sentinel?.release().catch(() => undefined);
    };
  }, [active]);
}
