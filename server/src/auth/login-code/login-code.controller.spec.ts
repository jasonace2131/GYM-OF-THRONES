import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { RequestMethod } from '@nestjs/common';
import { HTTP_CODE_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { EmailService } from '../../notifications/email.service';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ALLOW_UNVERIFIED_LOGIN_KEY } from '../decorators/allow-unverified-login.decorator';
import type { AuthSession, AuthUser } from '../auth.types';
import { LoginGateService } from '../login-gate.service';
import { LoginCodeController } from './login-code.controller';
import { LoginCodeService } from './login-code.service';

const USER = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } as AuthUser;
const SESSION: AuthSession = {
  sessionId: '99999999-9999-4999-8999-999999999999',
  viaEmailLink: false,
  signedInAt: null,
};

/** Every .ts file under `dir`, recursively. */
function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.ts') ? [full] : [];
  });
}

/**
 * The decorators ARE the access rule and the abuse bound on these routes, and
 * a dropped one fails no behavioural test — so they are asserted directly.
 */
describe('LoginCodeController', () => {
  const proto = LoginCodeController.prototype;
  const meta = (key: string, name: keyof LoginCodeController): unknown =>
    // Reading metadata off the function object, never calling it.
    // eslint-disable-next-line @typescript-eslint/unbound-method
    Reflect.getMetadata(key, proto[name]);

  it('is open to an unverified sign-in, at the class level', () => {
    expect(Reflect.getMetadata(ALLOW_UNVERIFIED_LOGIN_KEY, LoginCodeController)).toBe(true);
  });

  /**
   * The exemption sits on the class, so a third handler added here would
   * inherit it silently. Pin the route list to exactly the two it is for.
   */
  it('has exactly the two routes the class-level exemption is meant for', () => {
    const routes = (Object.getOwnPropertyNames(proto) as (keyof LoginCodeController)[])
      .filter((name) => (name as string) !== 'constructor')
      .filter((name) => meta(PATH_METADATA, name) !== undefined)
      .map((name) => [name, meta(METHOD_METADATA, name), meta(PATH_METADATA, name)]);

    expect(Reflect.getMetadata(PATH_METADATA, LoginCodeController)).toBe('auth/login-code');
    expect(routes).toEqual([
      ['send', RequestMethod.POST, '/'],
      ['verify', RequestMethod.POST, 'verify'],
    ]);
  });

  it('is the only place in the server that uses @AllowUnverifiedLogin()', () => {
    const srcRoot = join(__dirname, '..', '..');
    const users = sourceFiles(srcRoot)
      .filter((file) => !file.endsWith('.spec.ts'))
      .filter((file) => readFileSync(file, 'utf8').includes('@AllowUnverifiedLogin()'))
      .map((file) => file.slice(srcRoot.length + 1).replace(/\\/g, '/'));

    expect(users).toEqual(['auth/login-code/login-code.controller.ts']);
  });

  it.each(['send', 'verify'] as const)('%s still needs a token — it is not @Public()', (name) => {
    expect(meta(IS_PUBLIC_KEY, name)).toBeUndefined();
    expect(Reflect.getMetadata(IS_PUBLIC_KEY, LoginCodeController)).toBeUndefined();
  });

  it('send throttles default 5/min and origin 30/min', () => {
    expect(meta('THROTTLER:LIMITdefault', 'send')).toBe(5);
    expect(meta('THROTTLER:TTLdefault', 'send')).toBe(60_000);
    expect(meta('THROTTLER:LIMITorigin', 'send')).toBe(30);
    expect(meta('THROTTLER:TTLorigin', 'send')).toBe(60_000);
  });

  it('verify throttles default 10/min and origin 60/min', () => {
    expect(meta('THROTTLER:LIMITdefault', 'verify')).toBe(10);
    expect(meta('THROTTLER:TTLdefault', 'verify')).toBe(60_000);
    expect(meta('THROTTLER:LIMITorigin', 'verify')).toBe(60);
    expect(meta('THROTTLER:TTLorigin', 'verify')).toBe(60_000);
  });

  it.each(['send', 'verify'] as const)('%s answers 200, not 201', (name) => {
    expect(meta(HTTP_CODE_METADATA, name)).toBe(200);
  });

  describe('forwarding', () => {
    const service = {
      send: jest.fn().mockResolvedValue('sent'),
      verify: jest.fn().mockResolvedValue('verified'),
    };
    const controller = new LoginCodeController(service as unknown as LoginCodeService);

    it('send passes the caller and their sign-in', async () => {
      await expect(controller.send(USER, SESSION)).resolves.toBe('sent');
      expect(service.send).toHaveBeenCalledWith(USER, SESSION);
    });

    it('verify passes the caller, their sign-in and the code', async () => {
      await expect(controller.verify({ code: '123456' }, USER, SESSION)).resolves.toBe('verified');
      expect(service.verify).toHaveBeenCalledWith(USER, SESSION, '123456');
    });
  });

  /**
   * LoginCodeService's dependencies come from AuthModule (LoginGateService)
   * and the global Prisma, Config and Notifications modules. Compiling the
   * controller against stand-ins for exactly those proves the injection
   * tokens resolve, without a database.
   */
  it('resolves through Nest DI', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [LoginCodeController],
      providers: [
        LoginCodeService,
        { provide: PrismaService, useValue: {} },
        { provide: ConfigService, useValue: { get: () => 'pepper' } },
        { provide: EmailService, useValue: {} },
        { provide: LoginGateService, useValue: {} },
      ],
    }).compile();

    expect(moduleRef.get(LoginCodeController)).toBeInstanceOf(LoginCodeController);
    await moduleRef.close();
  });
});
