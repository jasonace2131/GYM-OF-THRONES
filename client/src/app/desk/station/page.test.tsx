import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

/**
 * A tablet whose key was disconnected in Admin → Stations (owner bug report,
 * 2026-11-07). It used to sit on "CHECK IN AT THE DESK — Our network is down"
 * with no button and no field, still sending the dead key, so every new key
 * made in admin was never used ("Last seen: never"). It must forget the dead
 * key and open the key screen by itself.
 */

vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(''),
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
vi.mock('@/lib/sessionReplaced', () => ({ signOutReplacedSession: vi.fn() }));
vi.mock('@/components/desk/StationQr', () => ({ StationQr: () => null }));

import StationDisplayPage from './page';
import { STATION_KEY_STORAGE } from '@/lib/stationClient';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
const fetchMock = vi.fn();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  window.localStorage.clear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 50));
  });
};

describe('a tablet whose key was disconnected', () => {
  it('forgets the dead key and opens the key screen, saying why', async () => {
    window.localStorage.setItem(STATION_KEY_STORAGE, 'a-key-that-was-disconnected');
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          success: false,
          error: { code: 'HTTP_401', message: 'Invalid station credential' },
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } },
      ),
    );

    await act(async () => root.render(<StationDisplayPage />));
    await settle();

    expect(window.localStorage.getItem(STATION_KEY_STORAGE)).toBeNull();
    expect(container.querySelector('.st-screen')?.getAttribute('data-state')).toBe('UNCONFIGURED');
    expect(container.textContent).toContain('This tablet was disconnected');
    expect(container.textContent).not.toContain('Our network is down');
  });

  it('keeps its key through a network outage, which is not a disconnection', async () => {
    window.localStorage.setItem(STATION_KEY_STORAGE, 'a-working-key');
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    await act(async () => root.render(<StationDisplayPage />));
    await settle();

    expect(window.localStorage.getItem(STATION_KEY_STORAGE)).toBe('a-working-key');
    expect(container.querySelector('.st-screen')?.getAttribute('data-state')).not.toBe(
      'UNCONFIGURED',
    );
  });
});
