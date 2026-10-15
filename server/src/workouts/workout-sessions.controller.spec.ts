import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  REQUIRE_PERMISSION_KEY,
  REQUIRE_PERMISSION_SCOPE_KEY,
} from '../rbac/decorators/require-permission.decorator';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import type { AuthUser } from '../auth/auth.types';
import type { WorkoutSessionsService } from './workout-sessions.service';
import { WorkoutSessionsController } from './workout-sessions.controller';
import type { LogSetDto, StartSessionDto } from './dto/workout-sessions.dto';

/**
 * The decorators are this controller's access control and its replay
 * protection, and a dropped one fails no behavioural test — so they are
 * pinned here (feat/workout-sessions).
 */
describe('WorkoutSessionsController', () => {
  const handler = (name: string): object =>
    (WorkoutSessionsController.prototype as unknown as Record<string, object>)[name];
  const meta = (key: string, name: string): unknown => Reflect.getMetadata(key, handler(name));

  const ROUTES: Record<string, [RequestMethod, string]> = {
    start: [RequestMethod.POST, '/'],
    list: [RequestMethod.GET, '/'],
    current: [RequestMethod.GET, 'current'],
    get: [RequestMethod.GET, ':id'],
    summary: [RequestMethod.GET, ':id/summary'],
    logSet: [RequestMethod.PUT, ':id/sets/:exerciseIndex/:setIndex'],
    unlogSet: [RequestMethod.DELETE, ':id/sets/:exerciseIndex/:setIndex'],
    finish: [RequestMethod.POST, ':id/finish'],
    patch: [RequestMethod.PATCH, ':id'],
    discard: [RequestMethod.DELETE, ':id'],
  };
  const HANDLERS = Object.keys(ROUTES);

  it('lives under me/workouts/sessions with exactly these routes', () => {
    expect(Reflect.getMetadata(PATH_METADATA, WorkoutSessionsController)).toBe(
      'me/workouts/sessions',
    );
    for (const [name, [method, path]] of Object.entries(ROUTES)) {
      expect([name, meta(METHOD_METADATA, name), meta(PATH_METADATA, name)]).toEqual([
        name,
        method,
        path,
      ]);
    }
  });

  it('declares GET current before GET :id, so "current" is never read as an id', () => {
    const order = Object.getOwnPropertyNames(WorkoutSessionsController.prototype);
    expect(order.indexOf('current')).toBeLessThan(order.indexOf('get'));
  });

  it('gates every route on workout.member at whatever reach the caller holds', () => {
    for (const name of HANDLERS) {
      expect([name, meta(REQUIRE_PERMISSION_KEY, name)]).toEqual([name, 'workout.member']);
      expect(meta(REQUIRE_PERMISSION_SCOPE_KEY, name)).toBeUndefined();
    }
  });

  it('replay-protects the two POSTs; PUT and DELETE are idempotent by key instead', () => {
    for (const name of HANDLERS) {
      expect([name, meta(IDEMPOTENT_KEY, name)]).toEqual([
        name,
        ['start', 'finish'].includes(name) ? true : undefined,
      ]);
    }
  });

  it('answers 201 for a started session and 200 for a finish', () => {
    expect(meta(HTTP_CODE_METADATA, 'start')).toBeUndefined();
    expect(meta(HTTP_CODE_METADATA, 'finish')).toBe(200);
  });

  it('hands the service the caller, the shared union and the raw set body', async () => {
    const service = {
      start: jest.fn().mockResolvedValue('view'),
      logSet: jest.fn().mockResolvedValue('set'),
    };
    const controller = new WorkoutSessionsController(service as unknown as WorkoutSessionsService);
    const user = { id: 'member-1' } as AuthUser;

    const startDto: StartSessionDto = { source: 'COACH_PLAN', dayIndex: 1 };
    await controller.start(user, startDto);
    expect(service.start).toHaveBeenCalledWith('member-1', { source: 'COACH_PLAN', dayIndex: 1 });

    const setDto: LogSetDto = { weightKg: null, reps: 12 };
    await controller.logSet(user, 'sess-1', '0', '2', setDto);
    expect(service.logSet).toHaveBeenCalledWith('member-1', 'sess-1', '0', '2', {
      weightKg: null,
      reps: 12,
    });
  });
});
