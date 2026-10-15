import { describe, expect, it, vi } from 'vitest';
import { POLL_INTERVAL_MS, POLL_MAX_MS, nextPoll, pollDraft } from './polling';

describe('nextPoll', () => {
  it('polls every 800 ms while the draft is RUNNING', () => {
    expect(POLL_INTERVAL_MS).toBe(800);
    expect(nextPoll({ status: 'RUNNING' }, 0)).toEqual({ kind: 'continue', delayMs: 800 });
    expect(nextPoll({ status: 'RUNNING' }, 60_000)).toEqual({ kind: 'continue', delayMs: 800 });
  });

  it('stops on READY, FAILED and a 404', () => {
    expect(nextPoll({ status: 'READY' }, 1_000)).toEqual({ kind: 'stop', reason: 'READY' });
    expect(nextPoll({ status: 'FAILED' }, 1_000)).toEqual({ kind: 'stop', reason: 'FAILED' });
    expect(nextPoll({ missing: true }, 1_000)).toEqual({ kind: 'stop', reason: 'MISSING' });
  });

  it('gives up after 90 s — the server has FAILED a draft that old anyway', () => {
    expect(POLL_MAX_MS).toBe(90_000);
    expect(nextPoll({ status: 'RUNNING' }, 90_000)).toEqual({ kind: 'stop', reason: 'TIMEOUT' });
  });
});

describe('pollDraft', () => {
  const running = { status: 'RUNNING' as const };
  const ready = { status: 'READY' as const };

  it('reports every draft it reads and resolves with the stop reason', async () => {
    const reads = [running, running, ready];
    let i = 0;
    const fetchDraft = vi.fn(async () => reads[i++] ?? ready);
    const onDraft = vi.fn();
    const sleep = vi.fn(async () => undefined);
    let clock = 0;
    const now = () => (clock += 100);

    const result = await pollDraft({ fetchDraft, onDraft, sleep, now });

    expect(result).toEqual({ reason: 'READY', draft: ready });
    expect(fetchDraft).toHaveBeenCalledTimes(3);
    expect(onDraft).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(800);
  });

  it('treats a 404 as MISSING and any other failure as a read error to retry', async () => {
    const notFound = Object.assign(new Error('gone'), { name: 'ApiError', status: 404 });
    const fetchDraft = vi.fn(async () => {
      throw notFound;
    });
    const result = await pollDraft({
      fetchDraft,
      onDraft: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(result).toEqual({ reason: 'MISSING', draft: null });

    let n = 0;
    const flaky = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new TypeError('offline');
      return ready;
    });
    const retried = await pollDraft({
      fetchDraft: flaky,
      onDraft: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(retried.reason).toBe('READY');
    expect(flaky).toHaveBeenCalledTimes(2);
  });

  it('stops when cancelled between reads', async () => {
    let cancelled = false;
    const fetchDraft = vi.fn(async () => {
      cancelled = true;
      return running;
    });
    const result = await pollDraft({
      fetchDraft,
      onDraft: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
      isCancelled: () => cancelled,
    });
    expect(result).toEqual({ reason: 'CANCELLED', draft: running });
    expect(fetchDraft).toHaveBeenCalledTimes(1);
  });

  it('times out after 90 s of RUNNING', async () => {
    let clock = 0;
    const result = await pollDraft({
      fetchDraft: async () => running,
      onDraft: () => undefined,
      sleep: async () => undefined,
      now: () => (clock += 30_000),
    });
    expect(result.reason).toBe('TIMEOUT');
  });
});
