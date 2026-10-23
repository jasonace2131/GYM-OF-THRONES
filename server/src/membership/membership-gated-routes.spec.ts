import { METHOD_METADATA } from '@nestjs/common/constants';
import { REQUIRE_ACTIVE_MEMBERSHIP_KEY } from './require-active-membership.decorator';
import { WorkoutsController } from '../workouts/workouts.controller';
import { WorkoutSessionsController } from '../workouts/workout-sessions.controller';
import { AssistantController } from '../assistant/assistant.controller';
import { ChatController } from '../chat/chat.controller';
import { MeController } from '../me/me.controller';

/**
 * Which routes need an ACTIVE membership (owner, 2026-10-17). A dropped
 * decorator fails no behavioural test, so the list is pinned here.
 *
 * Gated: everything that spends AI quota or writes to a gated feature.
 * Open: every read, so an expired member keeps their history — plans, past
 * sessions, progress, past chats.
 */
type Proto = Record<string, object>;

/** Every route handler on a controller: the methods Nest gave an HTTP verb. */
const routeHandlers = (controller: { prototype: object }): string[] =>
  Object.getOwnPropertyNames(controller.prototype).filter((name) => {
    const value = (controller.prototype as Record<string, unknown>)[name];
    return (
      name !== 'constructor' &&
      typeof value === 'function' &&
      Reflect.getMetadata(METHOD_METADATA, value) !== undefined
    );
  });
const gated = (controller: { prototype: object }, name: string): unknown => {
  const handler = (controller.prototype as Proto)[name];
  if (handler === undefined) throw new Error(`no handler ${name}`);
  return Reflect.getMetadata(REQUIRE_ACTIVE_MEMBERSHIP_KEY, handler);
};

/**
 * [name, controller, gated, open, exhaustive]. On the four member-feature
 * controllers EVERY route must be listed one way or the other, so a new
 * mutating route cannot ship ungated by being forgotten here. MeController
 * holds many unrelated routes; only the gated features' reads are pinned.
 */
const CASES: ReadonlyArray<[string, { prototype: object }, string[], string[], boolean]> = [
  [
    'WorkoutsController',
    WorkoutsController,
    [
      'startDraft',
      'cancelDraft',
      'savePlan',
      'patchPlan',
      'putPlanBody',
      'deletePlan',
      'swap',
      'adjust',
      'useCoachPlan',
    ],
    // `guide` is open: a cached How-to costs nothing, and the service itself
    // refuses a lapsed member the cache MISS that would spend Gemini.
    ['home', 'draft', 'plan', 'guide'],
    true,
  ],
  [
    'WorkoutSessionsController',
    WorkoutSessionsController,
    ['start', 'logSet', 'unlogSet', 'finish', 'patch', 'discard'],
    ['list', 'current', 'get', 'summary'],
    true,
  ],
  [
    'AssistantController',
    AssistantController,
    ['ask'],
    ['status', 'conversations', 'conversation'],
    true,
  ],
  // Coach chat is shared with coaches (never gated — the guard skips staff).
  // A member may still read, mark read and withdraw; only sending is gated.
  [
    'ChatController',
    ChatController,
    ['send'],
    ['threads', 'messages', 'read', 'remove', 'openWith'],
    true,
  ],
  // My Progress and My Coach are read-only for a member already: the old
  // progress writes are 403 stubs and the coach records progress.
  ['MeController', MeController, [], ['progressSummary', 'myCoach', 'myBookingWindow'], false],
];

describe.each(CASES)('%s', (_name, controller, gatedRoutes, openRoutes, exhaustive) => {
  if (exhaustive) {
    it('lists every route handler as gated or open — none forgotten', () => {
      const listed = new Set([...gatedRoutes, ...openRoutes]);
      const handlers = routeHandlers(controller);
      expect(handlers.filter((name) => !listed.has(name))).toEqual([]);
      expect([...listed].filter((name) => !handlers.includes(name))).toEqual([]);
    });
  }

  it('gates every write and every AI spend', () => {
    for (const route of gatedRoutes)
      expect([route, gated(controller, route)]).toEqual([route, true]);
  });

  it('leaves every read open', () => {
    for (const route of openRoutes) {
      expect([route, gated(controller, route)]).toEqual([route, undefined]);
    }
  });
});
