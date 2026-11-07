import { plainToInstance } from 'class-transformer';
import { validateSync, type ValidationError } from 'class-validator';
import { RoleParamDto, SaveRoleAccessDto } from './role-access.dto';

const flatten = (errors: ValidationError[]): string[] =>
  errors.flatMap((error) => [
    ...Object.keys(error.constraints ?? {}),
    ...flatten(error.children ?? []),
  ]);

function parse<T extends object>(
  cls: new () => T,
  payload: unknown,
): { dto: T; constraints: string[] } {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  return {
    dto,
    constraints: flatten(validateSync(dto, { whitelist: true, forbidNonWhitelisted: true })),
  };
}

const valid = {
  grants: [
    { key: 'payment.read', scope: 'ALL' },
    { key: 'checkin.self', scope: 'OWN' },
  ],
  reason: '  Desk handles refunds  ',
};

describe('SaveRoleAccessDto', () => {
  it('accepts a full set and trims the reason', () => {
    const { dto, constraints } = parse(SaveRoleAccessDto, valid);
    expect(constraints).toEqual([]);
    expect(dto.reason).toBe('Desk handles refunds');
  });

  it('accepts an empty set: the rules, not the shape, decide whether a role may hold nothing', () => {
    expect(parse(SaveRoleAccessDto, { ...valid, grants: [] }).constraints).toEqual([]);
  });

  it('refuses a missing or too-short reason', () => {
    expect(parse(SaveRoleAccessDto, { grants: [] }).constraints).toContain('isLength');
    expect(parse(SaveRoleAccessDto, { ...valid, reason: ' ab ' }).constraints).toEqual([
      'isLength',
    ]);
  });

  it('refuses the same key twice, a bad scope and a malformed key', () => {
    const twice = { ...valid, grants: [valid.grants[0], { key: 'payment.read', scope: 'OWN' }] };
    expect(parse(SaveRoleAccessDto, twice).constraints).toEqual(['arrayUnique']);
    const scope = { ...valid, grants: [{ key: 'payment.read', scope: 'SOME' }] };
    expect(parse(SaveRoleAccessDto, scope).constraints).toEqual(['isIn']);
    const key = { ...valid, grants: [{ key: 'DROP TABLE', scope: 'ALL' }] };
    expect(parse(SaveRoleAccessDto, key).constraints).toEqual(['matches']);
  });

  it('refuses a stray field', () => {
    expect(parse(SaveRoleAccessDto, { ...valid, role: 'ADMIN' }).constraints).toEqual([
      'whitelistValidation',
    ]);
  });
});

describe('RoleParamDto', () => {
  it('takes every role name, DEV included (the service refuses it with a reason)', () => {
    for (const role of ['CLIENT', 'FRONT_DESK', 'COACH', 'ADMIN', 'DEV']) {
      expect(parse(RoleParamDto, { role }).constraints).toEqual([]);
    }
    expect(parse(RoleParamDto, { role: 'OWNER' }).constraints).toEqual(['isIn']);
  });
});
