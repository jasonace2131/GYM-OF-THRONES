import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { Role } from '@prisma/client';
import { ChangeRoleDto } from './change-role.dto';

function parse(payload: Record<string, unknown>): { dto: ChangeRoleDto; constraints: string[] } {
  const dto = plainToInstance(ChangeRoleDto, payload, { enableImplicitConversion: true });
  const constraints = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.keys(error.constraints ?? {}),
  );
  return { dto, constraints };
}

describe('ChangeRoleDto', () => {
  it('still accepts a bare role — the reason is optional on the wire', () => {
    expect(parse({ role: Role.COACH }).constraints).toEqual([]);
  });

  it('accepts a reason, trimmed, so the console can record why a role moved', () => {
    const { dto, constraints } = parse({ role: Role.ADMIN, reason: '  covering the owner  ' });
    expect(constraints).toEqual([]);
    expect(dto.reason).toBe('covering the owner');
  });

  it('holds the reason to the same 3–200 bound as every other reason in the API', () => {
    expect(parse({ role: Role.ADMIN, reason: ' ab ' }).constraints).toEqual(['isLength']);
    expect(parse({ role: Role.ADMIN, reason: 'a'.repeat(201) }).constraints).toEqual(['isLength']);
  });

  it('still refuses DEV', () => {
    expect(parse({ role: Role.DEV }).constraints).toEqual(['isIn']);
  });
});
