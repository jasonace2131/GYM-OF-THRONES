'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from 'react';
import type { MemberAccess } from '@got/shared';
import { supabase } from '@/lib/supabase';
import { ApiError, apiFetch, onApiForbidden } from '@/lib/api';
import { hasPermission, type PermissionOptions } from '@/lib/rbac/permissions';
import {
  INITIAL_ME,
  meReducer,
  shouldRefetchOnFocus,
  shouldRefetchOnForbidden,
  type MeSnapshot,
} from '@/lib/rbac/meState';

/**
 * ONE `/me` PER SURFACE, SHARED BY EVERYTHING ON IT.
 *
 * The caller's own profile and effective permission set. Each shell — the
 * console and the member portal — mounts one `MeProvider`, and every nav
 * item, page guard and button reads it through `useMe`, `usePermission`,
 * `<Can>` or `<RequirePermission>`. Before this there were fourteen hand-built
 * permission sets, all scope-blind, and the portal's pages could not gate at
 * all because the shell kept `/me` to itself.
 *
 * DENY WHILE LOADING. Until `/me` answers, every check is false: a gated
 * control is absent, and a guarded page shows a skeleton — never the
 * privileged UI for a frame.
 *
 * KEPT FRESH. `/me` is re-read when the tab regains focus or becomes visible
 * (at most once a minute), on every sign-in/refresh event, and straight after
 * any 403 from `apiFetch` — a 403 usually means a grant was revoked since the
 * page loaded, and this is how the nav and guards catch up without a reload.
 *
 * Hiding a control is not a security control. Every route is
 * permission-checked server-side; this only stops people being shown doors
 * the server will refuse to open.
 */

/** `GET /me`, as far as the shells use it. */
export interface Me {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: string;
  status: string;
  permissions: { key: string; scope: string }[];
  /**
   * What the caller may do in the member-only features (owner, 2026-10-17),
   * decided by the server — read through `memberAccessOf`. Optional so a
   * bundle survives an API that predates it.
   */
  memberAccess?: MemberAccess;
}

/** Which shell a provider serves — decides where "home" is for a guard. */
export type MeSurface = 'admin' | 'portal';

export interface MeContextValue extends MeSnapshot<Me> {
  surface: MeSurface | null;
  /** Re-read `/me` now. From an error state it goes back to `loading` first. */
  reload: () => void;
}

const LOADING: MeContextValue = { ...INITIAL_ME, surface: null, reload: () => undefined };

const MeContext = createContext<MeContextValue | null>(null);

export function MeProvider({ surface, children }: { surface: MeSurface; children: ReactNode }) {
  const [state, dispatch] = useReducer(meReducer<Me>, INITIAL_ME as MeSnapshot<Me>);

  // The latest state for listeners that must not be re-bound on every change.
  const latest = useRef(state);
  useEffect(() => {
    latest.current = state;
  }, [state]);

  /**
   * Every load takes a ticket; only the newest ticket may write. A sign-in
   * event must beat a refetch that started under the previous session, and
   * nothing may land after unmount.
   */
  const ticket = useRef(0);
  const inFlight = useRef(false);
  const lastForbiddenAt = useRef<number | null>(null);

  const load = useCallback(async (): Promise<void> => {
    const mine = ++ticket.current;
    inFlight.current = true;
    try {
      const { data } = await supabase.auth.getSession();
      if (mine !== ticket.current) return;
      if (data.session === null) {
        dispatch({ type: 'signedOut' });
        return;
      }
      const me = await apiFetch<Me>('/me');
      if (mine === ticket.current) dispatch({ type: 'loaded', me, at: Date.now() });
    } catch (caught) {
      if (mine !== ticket.current) return;
      // 401 and 403 are answers; anything else — offline, 5xx, 429, a dev
      // server mid-restart — is a failure to ASK, and the reducer keeps the
      // last known profile through it.
      dispatch({ type: 'failed', status: caught instanceof ApiError ? caught.status : null });
    } finally {
      if (mine === ticket.current) inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void load();

    // `void`, never awaited: supabase-js holds its auth lock while it runs
    // these callbacks, and `load` reads the session.
    const { data: sub } = supabase.auth.onAuthStateChange((event) => {
      // The mount load above already covers the initial session.
      if (event === 'INITIAL_SESSION') return;
      if (event === 'SIGNED_OUT') {
        ticket.current += 1;
        inFlight.current = false;
        dispatch({ type: 'signedOut' });
        return;
      }
      void load();
    });

    const refreshIfStale = (): void => {
      if (document.visibilityState !== 'visible') return;
      if (inFlight.current || latest.current.status !== 'ready') return;
      if (shouldRefetchOnFocus(latest.current.fetchedAt, Date.now())) void load();
    };
    document.addEventListener('visibilitychange', refreshIfStale);
    window.addEventListener('focus', refreshIfStale);

    const offForbidden = onApiForbidden((path) => {
      const now = Date.now();
      if (inFlight.current) return;
      if (!shouldRefetchOnForbidden(path, lastForbiddenAt.current, now)) return;
      lastForbiddenAt.current = now;
      void load();
    });

    return () => {
      ticket.current += 1;
      sub.subscription.unsubscribe();
      document.removeEventListener('visibilitychange', refreshIfStale);
      window.removeEventListener('focus', refreshIfStale);
      offForbidden();
    };
  }, [load]);

  const reload = useCallback((): void => {
    dispatch({ type: 'retry' });
    void load();
  }, [load]);

  const value = useMemo<MeContextValue>(
    () => ({ ...state, surface, reload }),
    [state, surface, reload],
  );

  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

/**
 * A provider with a profile already in hand — no fetching. Backs the
 * console's legacy `AdminMeProvider` export.
 */
export function StaticMeProvider({
  me,
  surface,
  children,
}: {
  me: Me;
  surface: MeSurface;
  children: ReactNode;
}) {
  const value = useMemo<MeContextValue>(
    () => ({
      status: 'ready',
      me,
      errorStatus: null,
      fetchedAt: null,
      surface,
      reload: () => undefined,
    }),
    [me, surface],
  );
  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

/**
 * The caller's `/me` on this surface.
 *
 * Outside any provider it reports `loading` for ever, which denies every
 * check — a wiring mistake fails closed rather than painting privileged UI.
 */
export function useMe(): MeContextValue {
  return useContext(MeContext) ?? LOADING;
}

/** Whether the caller holds `key` (at `scope`). False while loading. */
export function usePermission(key: string, options?: PermissionOptions): boolean {
  const { me } = useMe();
  return hasPermission(me?.permissions ?? null, key, options);
}

/**
 * A checker bound to the caller's permissions, for a component that gates
 * many controls — one hook call instead of one per key. Same rules as
 * `usePermission`.
 */
export function useCan(): (key: string, options?: PermissionOptions) => boolean {
  const { me } = useMe();
  const permissions = me?.permissions ?? null;
  return useCallback(
    (key: string, options?: PermissionOptions) => hasPermission(permissions, key, options),
    [permissions],
  );
}
