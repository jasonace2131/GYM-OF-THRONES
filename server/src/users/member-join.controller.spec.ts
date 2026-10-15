import { HTTP_CODE_METADATA } from '@nestjs/common/constants';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';
import type { AuthUser } from '../auth/auth.types';
import { MemberJoinController } from './member-join.controller';
import type { MemberJoinService } from './member-join.service';

const TOKEN = 'T'.repeat(43);

/**
 * The decorators ARE the access control and the abuse bound on these routes,
 * and a dropped one fails no behavioural test — so they are asserted directly.
 */
describe('MemberJoinController', () => {
  const proto = MemberJoinController.prototype;
  const meta = (key: string, name: keyof MemberJoinController): unknown =>
    // Reading metadata off the function object, never calling it.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Reflect.getMetadata(key, proto[name]);

  it.each(['lookup', 'claimLink'] as const)(
    '%s is public — the member has no session yet',
    (name) => {
      expect(meta(IS_PUBLIC_KEY, name)).toBe(true);
    },
  );

  it('accept needs a session — the link is checked against the caller', () => {
    expect(meta(IS_PUBLIC_KEY, 'accept')).toBeUndefined();
  });

  it('lookup throttles default 10/min and origin 30/min', () => {
    expect(meta('THROTTLER:LIMITdefault', 'lookup')).toBe(10);
    expect(meta('THROTTLER:TTLdefault', 'lookup')).toBe(60_000);
    expect(meta('THROTTLER:LIMITorigin', 'lookup')).toBe(30);
    expect(meta('THROTTLER:TTLorigin', 'lookup')).toBe(60_000);
  });

  it('claimLink throttles default 5/min and origin 20/min', () => {
    expect(meta('THROTTLER:LIMITdefault', 'claimLink')).toBe(5);
    expect(meta('THROTTLER:TTLdefault', 'claimLink')).toBe(60_000);
    expect(meta('THROTTLER:LIMITorigin', 'claimLink')).toBe(20);
    expect(meta('THROTTLER:TTLorigin', 'claimLink')).toBe(60_000);
  });

  it.each(['claimLink', 'accept'] as const)('%s answers 200, not 201', (name) => {
    expect(meta(HTTP_CODE_METADATA, name)).toBe(200);
  });

  describe('forwarding', () => {
    const service = {
      lookup: jest.fn().mockResolvedValue('looked-up'),
      claimLink: jest.fn().mockResolvedValue('claimed'),
      accept: jest.fn().mockResolvedValue('accepted'),
    };
    const controller = new MemberJoinController(service as unknown as MemberJoinService);

    it('lookup passes the token', async () => {
      await expect(controller.lookup({ token: TOKEN })).resolves.toBe('looked-up');
      expect(service.lookup).toHaveBeenCalledWith(TOKEN);
    });

    it('claimLink passes the token and the Origin header', async () => {
      await expect(controller.claimLink({ token: TOKEN }, 'https://o')).resolves.toBe('claimed');
      expect(service.claimLink).toHaveBeenCalledWith(TOKEN, 'https://o');
    });

    it('accept passes the CALLER id, never an id from the body', async () => {
      const user = { id: 'u1', role: 'CLIENT' } as AuthUser;
      await expect(
        controller.accept({ token: TOKEN, dateOfBirth: '1995-03-02' }, user),
      ).resolves.toBe('accepted');
      expect(service.accept).toHaveBeenCalledWith('u1', TOKEN, '1995-03-02');
    });
  });
});
