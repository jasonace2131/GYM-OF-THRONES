import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import {
  FinishSessionDto,
  ListSessionsQueryDto,
  LogSetDto,
  PatchSessionDto,
  StartSessionDto,
  startBodyOf,
} from './workout-sessions.dto';

/**
 * The session routes' bodies at the pipe (feat/workout-sessions), validated
 * exactly as main.ts's global ValidationPipe does: implicit conversion on,
 * unknown fields rejected.
 */
function check<T extends object>(cls: new () => T, payload: object): { dto: T; failed: string[] } {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  const failed = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).map(
    (error) => error.property,
  );
  return { dto, failed };
}

const PLAN_ID = 'c0000000-0000-4000-8000-000000000001';

describe('StartSessionDto and startBodyOf', () => {
  it('accepts a member-plan day and a coach-plan day', () => {
    const member = check(StartSessionDto, { source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 3 });
    expect(member.failed).toEqual([]);
    expect(startBodyOf(member.dto)).toEqual({ source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 3 });

    const coach = check(StartSessionDto, { source: 'COACH_PLAN', dayIndex: 0 });
    expect(coach.failed).toEqual([]);
    expect(startBodyOf(coach.dto)).toEqual({ source: 'COACH_PLAN', dayIndex: 0 });
  });

  it('refuses a missing or out-of-range field for the chosen source', () => {
    expect(check(StartSessionDto, { source: 'MEMBER_PLAN', weekday: 3 }).failed).toEqual([
      'planId',
    ]);
    expect(
      check(StartSessionDto, { source: 'MEMBER_PLAN', planId: PLAN_ID, weekday: 7 }).failed,
    ).toEqual(['weekday']);
    expect(check(StartSessionDto, { source: 'COACH_PLAN', dayIndex: 7 }).failed).toEqual([
      'dayIndex',
    ]);
    expect(check(StartSessionDto, { source: 'COACH_PLAN' }).failed).toEqual(['dayIndex']);
    expect(check(StartSessionDto, { source: 'GYM_PLAN', dayIndex: 0 }).failed).toEqual(['source']);
    expect(check(StartSessionDto, { source: 'COACH_PLAN', dayIndex: 0, extra: 1 }).failed).toEqual([
      'extra',
    ]);
  });

  it("refuses the other source's fields rather than ignoring them", () => {
    const mixed = check(StartSessionDto, { source: 'COACH_PLAN', dayIndex: 0, planId: PLAN_ID });
    expect(() => startBodyOf(mixed.dto)).toThrow(BadRequestException);
    const mixedToo = check(StartSessionDto, {
      source: 'MEMBER_PLAN',
      planId: PLAN_ID,
      weekday: 1,
      dayIndex: 0,
    });
    expect(() => startBodyOf(mixedToo.dto)).toThrow(BadRequestException);
  });
});

describe('LogSetDto', () => {
  it('lets weightKg and reps through untouched for parseLogSetBody to judge', () => {
    const bodyweight = check(LogSetDto, { weightKg: null, reps: 12 });
    expect(bodyweight.failed).toEqual([]);
    expect(bodyweight.dto).toMatchObject({ weightKg: null, reps: 12 });

    // A string is NOT coerced here: the shared parser must see it and refuse it.
    const text = check(LogSetDto, { weightKg: '20', reps: '10' });
    expect(text.dto).toMatchObject({ weightKg: '20', reps: '10' });
  });

  it('rejects an unknown field at the pipe', () => {
    expect(check(LogSetDto, { weightKg: 20, reps: 10, done: true }).failed).toEqual(['done']);
  });
});

describe('FinishSessionDto and PatchSessionDto', () => {
  it('finish takes an optional feeling', () => {
    expect(check(FinishSessionDto, {}).failed).toEqual([]);
    expect(check(FinishSessionDto, { feeling: 'HARD' }).failed).toEqual([]);
    expect(check(FinishSessionDto, { feeling: 'MEH' }).failed).toEqual(['feeling']);
  });

  it('patch needs a feeling or an explicit null', () => {
    expect(check(PatchSessionDto, { feeling: 'EASY' }).failed).toEqual([]);
    expect(check(PatchSessionDto, { feeling: null }).failed).toEqual([]);
    expect(check(PatchSessionDto, {}).failed).toEqual(['feeling']);
    expect(check(PatchSessionDto, { feeling: 'MEH' }).failed).toEqual(['feeling']);
  });
});

describe('ListSessionsQueryDto', () => {
  it('reads limit from the query string, 1-50', () => {
    const ok = check(ListSessionsQueryDto, { limit: '10' });
    expect(ok.failed).toEqual([]);
    expect(ok.dto.limit).toBe(10);
    expect(check(ListSessionsQueryDto, {}).failed).toEqual([]);
    expect(check(ListSessionsQueryDto, { limit: '0' }).failed).toEqual(['limit']);
    expect(check(ListSessionsQueryDto, { limit: '51' }).failed).toEqual(['limit']);
  });
});
