import { describe, expect, it } from 'vitest';
import { dayCards, progressPercent, progressSteps, statusLine } from './draftProgress';
import { DAY_A, DRAFT_READY, DRAFT_RUNNING, INTAKE } from './fixtures';

const empty = {
  ...DRAFT_RUNNING,
  plan: { summary: null, days: [], guidance: null },
  firstDayMs: null,
};

describe('progressSteps', () => {
  it('lists Read your answers · one step per planned day · Wellness tips', () => {
    const steps = progressSteps(DRAFT_RUNNING);
    expect(steps.map((s) => `${s.label}|${s.detail ?? ''}|${s.state}`)).toEqual([
      'Read your answers||done',
      'Day 1 · Monday|Ready in 3.1 s|done',
      'Day 2 · Wednesday|Writing…|active',
      'Day 3 · Saturday||pending',
      'Wellness tips||pending',
    ]);
  });

  it('is reading the answers until the summary lands', () => {
    const steps = progressSteps(empty);
    expect(steps[0]).toMatchObject({ label: 'Read your answers', state: 'active' });
    expect(steps[1]).toMatchObject({ state: 'pending' });
  });

  it('is all done when READY', () => {
    expect(progressSteps(DRAFT_READY).every((s) => s.state === 'done')).toBe(true);
    expect(progressPercent(progressSteps(DRAFT_READY))).toBe(100);
    expect(progressPercent(progressSteps(DRAFT_RUNNING))).toBe(40);
    expect(progressPercent(progressSteps(empty))).toBe(0);
  });
});

describe('statusLine', () => {
  it('names what is ready and what is being written', () => {
    expect(statusLine(empty)).toBe('Reading your answers…');
    expect(statusLine(DRAFT_RUNNING)).toBe('Monday is ready. Writing Wednesday now.');
    const twoDone = {
      ...DRAFT_RUNNING,
      plan: { ...DRAFT_RUNNING.plan, days: [DAY_A, { ...DAY_A, weekday: 3 }] },
    };
    expect(statusLine(twoDone)).toBe('Monday and Wednesday are ready. Writing Saturday now.');
    const allDays = { ...DRAFT_RUNNING, plan: { ...DRAFT_READY.plan, guidance: null } };
    expect(statusLine(allDays)).toBe('Every day is ready. Writing your wellness tips…');
    expect(statusLine(DRAFT_READY)).toBe('Your plan is ready.');
    expect(statusLine({ ...DRAFT_RUNNING, status: 'FAILED', error: 'x' })).toBe(
      'The AI stopped part-way.',
    );
  });
});

describe('dayCards', () => {
  it('lands days as they arrive, in the intake order, with the rest as skeletons', () => {
    const cards = dayCards(DRAFT_RUNNING);
    expect(
      cards.map((c) => `${c.index + 1}:${c.weekday}:${c.state}:${c.day?.title ?? '-'}`),
    ).toEqual(['1:1:ready:Full body A', '2:3:writing:-', '3:6:pending:-']);
    expect(dayCards(DRAFT_READY).every((c) => c.state === 'ready')).toBe(true);
    expect(dayCards({ ...DRAFT_RUNNING, intake: { ...INTAKE, weekdays: [1] } })).toHaveLength(1);
  });
});
