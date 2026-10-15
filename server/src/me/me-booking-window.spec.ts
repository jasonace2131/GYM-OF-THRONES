import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { REQUIRE_PERMISSION_KEY } from '../rbac/decorators/require-permission.decorator';
import { MeController } from './me.controller';
import type { AuthUser } from '../auth/auth.types';

/**
 * `GET /me/booking-window` — how far ahead the member may book, and whether
 * their plan lets them book today (class-booking fixes, 2026-10-11). The rules
 * live in BookingsService.bookingWindow and are tested there; this pins the
 * route: keyless like the rest of /me, and about the token's user only.
 */
describe('MeController.myBookingWindow', () => {
  const handler = (MeController.prototype as unknown as Record<string, object>)['myBookingWindow'];

  it('is GET /me/booking-window, with no permission key', () => {
    expect(Reflect.getMetadata(METHOD_METADATA, handler as object)).toBe(RequestMethod.GET);
    expect(Reflect.getMetadata(PATH_METADATA, handler as object)).toBe('booking-window');
    expect(Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler as object)).toBeUndefined();
  });

  it('asks about the signed-in member, and nobody else', async () => {
    const window = { windowDays: 14 };
    const bookings = { bookingWindow: jest.fn().mockResolvedValue(window) };
    // MeController's eighth collaborator is BookingsService; the other seven
    // are inert placeholders this route never touches.
    const deps = Array.from({ length: 7 }, () => ({}));
    const controller = new (MeController as unknown as new (...args: unknown[]) => MeController)(
      ...deps,
      bookings,
    );

    await expect(controller.myBookingWindow({ id: 'm1' } as AuthUser)).resolves.toBe(window);
    expect(bookings.bookingWindow).toHaveBeenCalledWith('m1');
  });
});
