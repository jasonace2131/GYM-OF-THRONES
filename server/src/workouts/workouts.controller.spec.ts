import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  REQUIRE_PERMISSION_KEY,
  REQUIRE_PERMISSION_SCOPE_KEY,
} from '../rbac/decorators/require-permission.decorator';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import { WorkoutsController } from './workouts.controller';

/**
 * The decorators are this controller's access control, and a dropped one
 * fails no behavioural test — so they are pinned here (feat/member-workouts).
 */
describe('WorkoutsController', () => {
  const handler = (name: string): object =>
    (WorkoutsController.prototype as unknown as Record<string, object>)[name];
  const meta = (key: string, name: string): unknown => Reflect.getMetadata(key, handler(name));

  const HANDLERS = [
    'home',
    'startDraft',
    'draft',
    'cancelDraft',
    'savePlan',
    'plan',
    'patchPlan',
    'putPlanBody',
    'deletePlan',
    'swap',
    'adjust',
    'guide',
    'useCoachPlan',
  ];
  const POSTS = ['startDraft', 'savePlan', 'swap', 'adjust', 'useCoachPlan'];

  it('gates every route on workout.member at whatever reach the caller holds', () => {
    for (const name of HANDLERS) {
      expect(meta(REQUIRE_PERMISSION_KEY, name)).toBe('workout.member');
      expect(meta(REQUIRE_PERMISSION_SCOPE_KEY, name)).toBeUndefined();
    }
  });

  it('replay-protects every POST, and only the POSTs', () => {
    for (const name of POSTS) {
      expect([name, meta(IDEMPOTENT_KEY, name)]).toEqual([name, true]);
    }
    for (const name of HANDLERS.filter((n) => !POSTS.includes(n))) {
      expect(meta(IDEMPOTENT_KEY, name)).toBeUndefined();
    }
  });

  it('answers 202 for a started draft and 200 for the two tools and "use the coach\'s plan"', () => {
    expect(meta(HTTP_CODE_METADATA, 'startDraft')).toBe(202);
    expect(meta(HTTP_CODE_METADATA, 'swap')).toBe(200);
    expect(meta(HTTP_CODE_METADATA, 'adjust')).toBe(200);
    expect(meta(HTTP_CODE_METADATA, 'useCoachPlan')).toBe(200);
    expect(meta(HTTP_CODE_METADATA, 'savePlan')).toBeUndefined();
  });

  it('puts "use the coach\'s plan" at POST coach-plan/use', () => {
    expect(meta(METHOD_METADATA, 'useCoachPlan')).toBe(RequestMethod.POST);
    expect(meta(PATH_METADATA, 'useCoachPlan')).toBe('coach-plan/use');
  });
});
