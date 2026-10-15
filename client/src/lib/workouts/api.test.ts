import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api', () => ({
  apiFetch: vi.fn(),
  ApiError: class ApiError extends Error {},
}));

import { apiFetch } from '@/lib/api';
import { workoutsApi } from './api';
import { SUMMARY } from './fixtures';

const BASE = '/me/workouts';

/**
 * Thin-wrapper contract tests (the shape of coachApi.test.ts): each asserts
 * the path, method and body handed to `apiFetch` — spec §4's table, route by
 * route. `apiFetch` itself adds the Idempotency-Key to every POST.
 */
describe('workoutsApi — workout sessions', () => {
  beforeEach(() => {
    vi.mocked(apiFetch).mockReset();
    vi.mocked(apiFetch).mockResolvedValue(undefined);
  });

  it("adoptCoachPlan() hands Today to the coach's plan", async () => {
    await workoutsApi.adoptCoachPlan();
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/coach-plan/use`, { method: 'POST' });
  });

  it('startSession() posts the day to start', async () => {
    const body = { source: 'MEMBER_PLAN' as const, planId: 'plan-1', weekday: 3 };
    await workoutsApi.startSession(body);
    expect(apiFetch).toHaveBeenCalledWith(`${BASE}/sessions`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
  });

  it('currentSession() and session() read an open or finished workout', async () => {
    await workoutsApi.currentSession();
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/current`);
    await workoutsApi.session('s/1');
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/s%2F1`);
  });

  it('putSet() and deleteSet() address one set by its indexes', async () => {
    await workoutsApi.putSet('s1', 2, 0, { weightKg: 14, reps: 10 });
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/s1/sets/2/0`, {
      method: 'PUT',
      body: JSON.stringify({ weightKg: 14, reps: 10 }),
    });
    await workoutsApi.deleteSet('s1', 2, 0);
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/s1/sets/2/0`, {
      method: 'DELETE',
    });
  });

  it('sendOp() turns a queued op into its PUT or DELETE', async () => {
    await workoutsApi.sendOp({
      kind: 'put',
      sessionId: 's1',
      exerciseIndex: 1,
      setIndex: 2,
      body: { weightKg: null, reps: 8 },
    });
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/s1/sets/1/2`, {
      method: 'PUT',
      body: JSON.stringify({ weightKg: null, reps: 8 }),
    });
    await workoutsApi.sendOp({ kind: 'delete', sessionId: 's1', exerciseIndex: 1, setIndex: 2 });
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/s1/sets/1/2`, {
      method: 'DELETE',
    });
  });

  it('finishSession(), patchSession() and discardSession() close a workout', async () => {
    await workoutsApi.finishSession('s1', {});
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/s1/finish`, {
      method: 'POST',
      body: '{}',
    });
    await workoutsApi.patchSession('s1', { feeling: 'RIGHT' });
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/s1`, {
      method: 'PATCH',
      body: JSON.stringify({ feeling: 'RIGHT' }),
    });
    await workoutsApi.discardSession('s1');
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/s1`, { method: 'DELETE' });
  });

  it('summary() and sessions() read history — the list comes back bare, 50 at most', async () => {
    await workoutsApi.summary('s1');
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions/s1/summary`);
    vi.mocked(apiFetch).mockResolvedValueOnce([SUMMARY]);
    await expect(workoutsApi.sessions(20)).resolves.toEqual([SUMMARY]);
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions?limit=20`);
    await workoutsApi.sessions();
    expect(apiFetch).toHaveBeenLastCalledWith(`${BASE}/sessions?limit=50`);
  });
});
