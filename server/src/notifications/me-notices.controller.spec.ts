import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import {
  REQUIRE_PERMISSION_KEY,
  REQUIRE_PERMISSION_SCOPE_KEY,
} from '../rbac/decorators/require-permission.decorator';
import { IDEMPOTENT_KEY } from '../common/decorators/idempotent.decorator';
import type { AuthUser } from '../auth/auth.types';
import { MeNoticesController } from './me-notices.controller';
import type { MemberNoticesService } from './member-notices.service';

const MEMBER = '11111111-1111-4111-8111-111111111111';

/**
 * The decorators are this controller's whole access story, and a dropped or
 * added one fails no behavioural test — so they are pinned here.
 */
describe('MeNoticesController', () => {
  const handler = (name: string): object =>
    (MeNoticesController.prototype as unknown as Record<string, object>)[name];
  const meta = (key: string, name: string): unknown => Reflect.getMetadata(key, handler(name));
  const classMeta = (key: string): unknown => Reflect.getMetadata(key, MeNoticesController);

  it('serves GET /me/notices and POST /me/notices/seen', () => {
    expect(classMeta(PATH_METADATA)).toBe('me/notices');
    expect(meta(METHOD_METADATA, 'feed')).toBe(RequestMethod.GET);
    expect(meta(PATH_METADATA, 'feed')).toBe('/');
    expect(meta(METHOD_METADATA, 'seen')).toBe(RequestMethod.POST);
    expect(meta(PATH_METADATA, 'seen')).toBe('seen');
  });

  /**
   * Keyless, like the rest of /me: every notice was written to the caller, so
   * a key could only mean "may read your own notices".
   */
  it('gates neither route on a permission', () => {
    expect(classMeta(REQUIRE_PERMISSION_KEY)).toBeUndefined();
    for (const name of ['feed', 'seen']) {
      expect(meta(REQUIRE_PERMISSION_KEY, name)).toBeUndefined();
      expect(meta(REQUIRE_PERMISSION_SCOPE_KEY, name)).toBeUndefined();
    }
  });

  /** Monotonic and self-bounded, so a replay re-applies nothing: no key needed. */
  it('answers seen with 200 and asks for no Idempotency-Key', () => {
    expect(meta(HTTP_CODE_METADATA, 'seen')).toBe(200);
    expect(meta(IDEMPOTENT_KEY, 'seen')).toBeUndefined();
    expect(meta(IDEMPOTENT_KEY, 'feed')).toBeUndefined();
  });

  it('acts on the token user, and turns upTo into an instant', async () => {
    const service = {
      feed: jest.fn().mockResolvedValue({ items: [], unreadCount: 0 }),
      markSeen: jest.fn().mockResolvedValue({ unreadCount: 0 }),
    };
    const controller = new MeNoticesController(service as unknown as MemberNoticesService);
    const user = { id: MEMBER } as AuthUser;

    await controller.feed(user, { page: 2, limit: 5 });
    await controller.seen(user, { upTo: '2026-10-11T11:15:00.000+08:00' });

    expect(service.feed).toHaveBeenCalledWith(MEMBER, { page: 2, limit: 5 });
    const [userId, upTo, now] = service.markSeen.mock.calls[0] as [string, Date, Date];
    expect(userId).toBe(MEMBER);
    expect(upTo.toISOString()).toBe('2026-10-11T03:15:00.000Z');
    expect(now).toBeInstanceOf(Date);
  });
});
