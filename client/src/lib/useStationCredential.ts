'use client';

import { useCallback, useSyncExternalStore } from 'react';
import { STATION_CODE_STORAGE, STATION_KEY_STORAGE, saveStationCredential } from './stationClient';

/**
 * The tablet's stored credential, read as an EXTERNAL STORE rather than
 * copied into state by an effect.
 *
 * `localStorage` is exactly what `useSyncExternalStore` is for: it exists
 * outside React, it can change without React knowing (another tab, or the
 * setup form), and it does not exist at all during server rendering. Reading
 * it in an effect and calling `setState` works, but it renders one wrong frame
 * first — on this screen that frame is the "not configured" panel flashing on
 * a working display every time the tablet reloads.
 *
 * `getServerSnapshot` returns null, which is honest: the server genuinely does
 * not know whether this tablet is provisioned, and claiming otherwise is a
 * hydration mismatch.
 */
export interface StationCredential {
  key: string | null;
  code: string | null;
}

const EMPTY: StationCredential = { key: null, code: null };

/** Cached so the snapshot is referentially stable between real changes. */
let snapshot: StationCredential = EMPTY;

function readSnapshot(): StationCredential {
  const key = window.localStorage.getItem(STATION_KEY_STORAGE);
  const code = window.localStorage.getItem(STATION_CODE_STORAGE);
  // `useSyncExternalStore` re-renders whenever the snapshot is not `Object.is`
  // to the last one, so returning a fresh object every call is an infinite
  // render loop. Only allocate when a value actually moved.
  if (snapshot.key !== key || snapshot.code !== code) snapshot = { key, code };
  return snapshot;
}

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  // `storage` fires only for OTHER tabs, never the one that wrote — which is
  // why `saveStationCredential` below notifies this tab by hand.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
}

export function useStationCredential(): {
  credential: StationCredential;
  save: (key: string, code: string) => void;
} {
  const credential = useSyncExternalStore(subscribe, readSnapshot, () => EMPTY);

  const save = useCallback((key: string, code: string) => {
    saveStationCredential(key, code);
    for (const listener of listeners) listener();
  }, []);

  return { credential, save };
}
