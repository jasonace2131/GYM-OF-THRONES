import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { UpdateMyProfileDto } from './update-my-profile.dto';

/** The app's own ValidationPipe options (main.ts), so unknown keys are refused here too. */
function parse(payload: Record<string, unknown>): {
  dto: UpdateMyProfileDto;
  constraints: string[];
} {
  const dto = plainToInstance(UpdateMyProfileDto, payload, { enableImplicitConversion: true });
  const constraints = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true }).flatMap(
    (error) => Object.keys(error.constraints ?? {}),
  );
  return { dto, constraints };
}

describe('UpdateMyProfileDto', () => {
  it('accepts an empty body — every field is optional', () => {
    expect(parse({}).constraints).toEqual([]);
  });

  it('accepts height and weight inside the bounds, one decimal allowed', () => {
    const { dto, constraints } = parse({ heightCm: 175.5, weightKg: 72.4 });
    expect(constraints).toEqual([]);
    expect(dto.heightCm).toBe(175.5);
    expect(dto.weightKg).toBe(72.4);
  });

  // The SAME bounds sign-up accepts (jwt-verifier.ts), so any value already
  // stored can be saved back unchanged.
  it("accepts the exact bounds, which are sign-up's", () => {
    expect(parse({ heightCm: 50, weightKg: 20 }).constraints).toEqual([]);
    expect(parse({ heightCm: 260, weightKg: 400 }).constraints).toEqual([]);
  });

  it('refuses a height outside 50–260 cm', () => {
    expect(parse({ heightCm: 49.9 }).constraints).toEqual(['min']);
    expect(parse({ heightCm: 260.1 }).constraints).toEqual(['max']);
  });

  it('refuses a weight outside 20–400 kg', () => {
    expect(parse({ weightKg: 19.9 }).constraints).toEqual(['min']);
    expect(parse({ weightKg: 400.1 }).constraints).toEqual(['max']);
  });

  it('accepts the medical-notes opt-in as a real boolean', () => {
    expect(parse({ shareMedicalWithPlanner: true }).dto.shareMedicalWithPlanner).toBe(true);
    expect(parse({ shareMedicalWithPlanner: false }).dto.shareMedicalWithPlanner).toBe(false);
    expect(parse({ shareMedicalWithPlanner: true }).constraints).toEqual([]);
  });

  it('refuses an opt-in that is not a boolean — "false" must never read as true', () => {
    expect(parse({ shareMedicalWithPlanner: 'false' }).constraints).toEqual(['isBoolean']);
    expect(parse({ shareMedicalWithPlanner: null }).constraints).toEqual(['isBoolean']);
  });

  it('refuses more than one decimal place', () => {
    expect(parse({ heightCm: 175.55 }).constraints).toEqual(['isNumber']);
    expect(parse({ weightKg: 72.45 }).constraints).toEqual(['isNumber']);
  });

  it('refuses a number that is not a number', () => {
    expect(parse({ heightCm: 'tall' }).constraints).toContain('isNumber');
  });

  it('accepts null, which clears a value', () => {
    const { dto, constraints } = parse({ heightCm: null, weightKg: null, medicalNotes: null });
    expect(constraints).toEqual([]);
    expect(dto.heightCm).toBeNull();
    expect(dto.weightKg).toBeNull();
    expect(dto.medicalNotes).toBeNull();
  });

  it('trims medical notes', () => {
    expect(parse({ medicalNotes: '  Bad left knee  ' }).dto.medicalNotes).toBe('Bad left knee');
  });

  it('turns blank medical notes into null', () => {
    const { dto, constraints } = parse({ medicalNotes: '   ' });
    expect(constraints).toEqual([]);
    expect(dto.medicalNotes).toBeNull();
  });

  it('holds medical notes to 2000 characters after the trim', () => {
    expect(parse({ medicalNotes: ` ${'a'.repeat(2000)} ` }).constraints).toEqual([]);
    expect(parse({ medicalNotes: 'a'.repeat(2001) }).constraints).toEqual(['maxLength']);
  });

  it('leaves an absent field undefined, so the service does not touch it', () => {
    const { dto } = parse({ weightKg: 70 });
    expect(dto.heightCm).toBeUndefined();
    expect(dto.medicalNotes).toBeUndefined();
  });

  it('refuses email — the member cannot set it through this API', () => {
    expect(parse({ email: 'new@example.com' }).constraints).toEqual(['whitelistValidation']);
  });

  it('refuses any other unknown field', () => {
    expect(parse({ role: 'ADMIN' }).constraints).toEqual(['whitelistValidation']);
  });
});
