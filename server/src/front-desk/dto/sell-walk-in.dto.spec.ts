import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { SellWalkInDto } from './sell-walk-in.dto';

async function check(body: Record<string, unknown>) {
  const dto = plainToInstance(SellWalkInDto, { kind: 'WALK_IN', ...body });
  return { dto, errors: await validate(dto) };
}

describe('SellWalkInDto.guestEmail', () => {
  it('trims and lower-cases, the one spelling CheckIn_guest_email_sane accepts', async () => {
    const { dto, errors } = await check({ guestEmail: '  Ana.Cruz@Example.COM ' });
    expect(errors).toEqual([]);
    expect(dto.guestEmail).toBe('ana.cruz@example.com');
  });

  it('is optional in the DTO — the service decides when it is required', async () => {
    const { errors } = await check({});
    expect(errors).toEqual([]);
  });

  it('refuses something that is not an email', async () => {
    const { errors } = await check({ guestEmail: 'not-an-email' });
    expect(errors.map((error) => error.property)).toEqual(['guestEmail']);
  });

  it('refuses an address over 254 characters', async () => {
    const { errors } = await check({ guestEmail: `${'a'.repeat(250)}@x.co` });
    expect(errors.map((error) => error.property)).toEqual(['guestEmail']);
  });
});
