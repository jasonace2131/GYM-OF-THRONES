import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  REQUIRE_PERMISSION_KEY,
  REQUIRE_PERMISSION_SCOPE_KEY,
} from '../rbac/decorators/require-permission.decorator';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import type { AuthUser } from '../auth/auth.types';
import { AdminClassesController, ClassesController } from './classes.controller';
import type { ClassesService } from './classes.service';
import type { BookingsService } from './bookings.service';

const SESSION_ID = '33333333-3333-4333-8333-333333333333';
const BOOKING_ID = '55555555-5555-4555-8555-555555555555';
const MEMBER_ID = '44444444-4444-4444-8444-444444444444';
const STAFF = { id: '66666666-6666-4666-8666-666666666666' } as AuthUser;

/**
 * The decorators ARE these controllers' access control, and a dropped or
 * swapped one fails no behavioural test — so each handler's key, replay
 * protection, status and route are pinned here (pattern:
 * workouts.controller.spec.ts).
 */
type Handler = { prototype: object };

const meta = (controller: Handler, key: string, name: string): unknown =>
  Reflect.getMetadata(key, (controller.prototype as Record<string, object>)[name]);

/** [controller, handler, permission key, method, path, @Idempotent, @HttpCode] */
const ROUTES: Array<[Handler, string, string, RequestMethod, string, boolean, number | undefined]> =
  [
    [ClassesController, 'list', 'class.read', RequestMethod.GET, '/', false, undefined],
    [ClassesController, 'findOne', 'class.read', RequestMethod.GET, ':id', false, undefined],
    // The member books for themselves only: booking.create, held by CLIENT at OWN.
    [
      ClassesController,
      'book',
      'booking.create',
      RequestMethod.POST,
      ':id/bookings',
      true,
      undefined,
    ],
    [
      ClassesController,
      'cancel',
      'booking.create',
      RequestMethod.DELETE,
      ':id/bookings',
      false,
      200,
    ],
    [
      ClassesController,
      'register',
      'booking.read',
      RequestMethod.GET,
      ':id/register',
      false,
      undefined,
    ],
    [AdminClassesController, 'create', 'class.manage', RequestMethod.POST, '/', true, undefined],
    [
      AdminClassesController,
      'update',
      'class.manage',
      RequestMethod.PATCH,
      ':id',
      false,
      undefined,
    ],
    [
      AdminClassesController,
      'cancelSession',
      'class.manage',
      RequestMethod.POST,
      ':id/cancel',
      false,
      undefined,
    ],
    // The desk's hand on who is in a class: its own key, never booking.create
    // (staff would book themselves), class.manage (the desk lacks it) or
    // booking.attend (every coach holds it).
    [
      AdminClassesController,
      'addMember',
      'booking.manage',
      RequestMethod.POST,
      ':id/bookings',
      true,
      undefined,
    ],
    [
      AdminClassesController,
      'removeMember',
      'booking.manage',
      RequestMethod.POST,
      'bookings/:bookingId/remove',
      false,
      200,
    ],
    [
      AdminClassesController,
      'markAttendance',
      'booking.attend',
      RequestMethod.POST,
      'bookings/:bookingId/attendance',
      false,
      undefined,
    ],
  ];

describe('ClassesController and AdminClassesController — the route table', () => {
  it('mounts the member routes at class-sessions and the staff ones at admin/class-sessions', () => {
    expect(Reflect.getMetadata(PATH_METADATA, ClassesController)).toBe('class-sessions');
    expect(Reflect.getMetadata(PATH_METADATA, AdminClassesController)).toBe('admin/class-sessions');
  });

  it.each(ROUTES.map((route) => [route[1], ...route] as const))(
    '%s: one permission key, its method and path, replay protection and status',
    (_name, controller, handler, key, method, path, idempotent, status) => {
      expect(meta(controller, REQUIRE_PERMISSION_KEY, handler)).toBe(key);
      // Reach is never insisted on here: every route works at whatever scope is held.
      expect(meta(controller, REQUIRE_PERMISSION_SCOPE_KEY, handler)).toBeUndefined();
      expect(meta(controller, METHOD_METADATA, handler)).toBe(method);
      expect(meta(controller, PATH_METADATA, handler)).toBe(path);
      expect(meta(controller, IDEMPOTENT_KEY, handler)).toBe(idempotent ? true : undefined);
      expect(meta(controller, HTTP_CODE_METADATA, handler)).toBe(status);
    },
  );

  it('pins every handler the two controllers have, so a new one cannot ship unpinned', () => {
    const handlers = (controller: Handler): string[] =>
      Object.getOwnPropertyNames(controller.prototype).filter((name) => name !== 'constructor');

    expect(handlers(ClassesController).sort()).toEqual(
      ROUTES.filter(([controller]) => controller === ClassesController)
        .map(([, name]) => name)
        .sort(),
    );
    expect(handlers(AdminClassesController).sort()).toEqual(
      ROUTES.filter(([controller]) => controller === AdminClassesController)
        .map(([, name]) => name)
        .sort(),
    );
  });
});

describe('the actor comes from the token, never from the request', () => {
  const services = () => {
    const classes = {
      update: jest.fn().mockResolvedValue({}),
      cancel: jest.fn().mockResolvedValue({}),
    };
    const bookings = {
      addByStaff: jest.fn().mockResolvedValue({}),
      removeByStaff: jest.fn().mockResolvedValue({}),
      markAttendance: jest.fn().mockResolvedValue({}),
      bookingWindow: jest.fn(),
    };
    const controller = new AdminClassesController(
      classes as unknown as ClassesService,
      bookings as unknown as BookingsService,
    );
    return { classes, bookings, controller };
  };

  it('passes the signed-in staffer to every staff write', async () => {
    const { classes, bookings, controller } = services();

    await controller.update(STAFF, SESSION_ID, { title: 'Spin' });
    await controller.cancelSession(STAFF, SESSION_ID, { reason: 'Coach is unwell' });
    await controller.addMember(STAFF, SESSION_ID, { userId: MEMBER_ID });
    await controller.removeMember(STAFF, BOOKING_ID, { reason: 'Moved to the 7pm' });
    await controller.markAttendance(STAFF, BOOKING_ID, { attended: false });

    expect(classes.update).toHaveBeenCalledWith(SESSION_ID, { title: 'Spin' }, STAFF.id);
    expect(classes.cancel).toHaveBeenCalledWith(SESSION_ID, 'Coach is unwell', STAFF.id);
    expect(bookings.addByStaff).toHaveBeenCalledWith(STAFF.id, SESSION_ID, MEMBER_ID);
    expect(bookings.removeByStaff).toHaveBeenCalledWith(STAFF.id, BOOKING_ID, 'Moved to the 7pm');
    expect(bookings.markAttendance).toHaveBeenCalledWith(STAFF.id, BOOKING_ID, false);
  });

  it('books and cancels as the signed-in member only', async () => {
    const bookings = {
      book: jest.fn().mockResolvedValue({}),
      cancel: jest.fn().mockResolvedValue({}),
    };
    const controller = new ClassesController(
      {} as unknown as ClassesService,
      bookings as unknown as BookingsService,
    );
    const member = { id: MEMBER_ID } as AuthUser;

    await controller.book(member, SESSION_ID);
    await controller.cancel(member, SESSION_ID);

    expect(bookings.book).toHaveBeenCalledWith(MEMBER_ID, SESSION_ID);
    expect(bookings.cancel).toHaveBeenCalledWith(MEMBER_ID, SESSION_ID);
  });
});
