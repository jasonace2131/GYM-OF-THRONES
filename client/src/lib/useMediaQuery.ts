'use client';

import { useEffect, useState } from 'react';

/** False on the server and on first paint; settles after mount. */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    const list = window.matchMedia(query);
    const update = (): void => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);

  return matches;
}

/** The phone layout: three-day week grid, bottom sheets. */
export const useIsPhone = (): boolean => useMediaQuery('(max-width: 640px)');
