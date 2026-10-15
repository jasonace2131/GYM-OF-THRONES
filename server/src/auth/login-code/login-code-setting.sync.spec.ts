import { Logger } from '@nestjs/common';
import type { EmailService } from '../../notifications/email.service';
import type { PrismaService } from '../../prisma/prisma.service';
import type { LoginGateService } from '../login-gate.service';
import { LoginCodeSettingSync } from './login-code-setting.sync';

function build(required: boolean, emailEnabled: boolean, upsert = jest.fn().mockResolvedValue({})) {
  const sync = new LoginCodeSettingSync(
    { loginCodeSetting: { upsert } } as unknown as PrismaService,
    { required } as unknown as LoginGateService,
    { enabled: emailEnabled } as unknown as EmailService,
  );
  return { sync, upsert };
}

describe('LoginCodeSettingSync', () => {
  let error: jest.SpyInstance;
  let log: jest.SpyInstance;
  const nodeEnv = process.env['NODE_ENV'];

  beforeEach(() => {
    process.env['NODE_ENV'] = 'production';
    error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    log = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.env['NODE_ENV'] = nodeEnv;
    error.mockRestore();
    log.mockRestore();
  });

  it('writes the kill switch into the one setting row the Realtime policy reads', async () => {
    const { sync, upsert } = build(false, true);
    await sync.onModuleInit();
    expect(upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: { id: 1, required: false },
      update: { required: false },
    });
    expect(error).not.toHaveBeenCalled();
  });

  it('logs an error, and still boots, when the gate is on but email is off', async () => {
    const { sync, upsert } = build(true, false);
    await sync.onModuleInit();
    expect(upsert).toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/LOGIN_CODE_REQUIRED.*email/i));
  });

  it('logs and carries on when the database refuses the write — never a boot failure', async () => {
    const { sync } = build(true, true, jest.fn().mockRejectedValue(new Error('P1001')));
    await expect(sync.onModuleInit()).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('P1001'));
  });

  describe('outside a production process (a laptop whose .env points at the live database)', () => {
    it.each([['development'], ['test'], [undefined]])(
      'NODE_ENV=%s leaves the live chat row alone and says so once',
      async (value) => {
        if (value === undefined) delete process.env['NODE_ENV'];
        else process.env['NODE_ENV'] = value;
        const { sync, upsert } = build(false, true);
        await sync.onModuleInit();
        expect(upsert).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledTimes(1);
        expect(log).toHaveBeenCalledWith(expect.stringMatching(/not synced.*not a production/i));
      },
    );

    it('still logs the gate-on-but-email-off error', async () => {
      process.env['NODE_ENV'] = 'development';
      const { sync, upsert } = build(true, false);
      await sync.onModuleInit();
      expect(upsert).not.toHaveBeenCalled();
      expect(error).toHaveBeenCalledWith(expect.stringMatching(/LOGIN_CODE_REQUIRED.*email/i));
    });
  });
});
