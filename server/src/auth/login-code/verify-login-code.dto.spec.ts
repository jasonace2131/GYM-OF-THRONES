import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { VerifyLoginCodeDto } from './verify-login-code.dto';

async function check(code: unknown): Promise<{ dto: VerifyLoginCodeDto; valid: boolean }> {
  const dto = plainToInstance(VerifyLoginCodeDto, { code });
  const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
  return { dto, valid: errors.length === 0 };
}

describe('VerifyLoginCodeDto', () => {
  it.each([
    ['123456', '123456'],
    ['012345', '012345'],
    [' 123456 ', '123456'],
    ['123 456', '123456'],
  ])('accepts %p as %p — spaces from a copy-paste are dropped', async (raw, expected) => {
    const { dto, valid } = await check(raw);
    expect(valid).toBe(true);
    expect(dto.code).toBe(expected);
  });

  it.each(['12345', '1234567', '12345a', '', '１２３４５６', null, undefined])(
    'refuses %p',
    async (raw) => {
      expect((await check(raw)).valid).toBe(false);
    },
  );

  it('refuses an unknown extra field', async () => {
    const dto = plainToInstance(VerifyLoginCodeDto, { code: '123456', remember: true });
    const errors = await validate(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.length).toBeGreaterThan(0);
  });
});
