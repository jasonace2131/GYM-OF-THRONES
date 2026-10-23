import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, Length, validateSync } from 'class-validator';
import { IsPaymentReference, IsPersonName, IsPhPhone, Trim, TrimOrNull } from './text.validators';

class Sample {
  @IsPersonName('name')
  name!: string;

  @IsOptional()
  @IsPhPhone()
  phone?: string | null;

  @IsOptional()
  @IsPaymentReference()
  reference?: string;

  @IsOptional()
  @IsPaymentReference({ allowBlank: true })
  amendReference?: string;

  @IsOptional()
  @Trim()
  @IsString()
  @Length(3, 200)
  reason?: string;

  @IsOptional()
  @TrimOrNull()
  @IsString()
  notes?: string | null;
}

function check(payload: Record<string, unknown>): { dto: Sample; failed: string[] } {
  const dto = plainToInstance(Sample, { name: 'Juan', ...payload });
  return { dto, failed: validateSync(dto).map((e) => e.property) };
}

describe('text validators', () => {
  it('collapses a name and accepts accents', () => {
    const { dto, failed } = check({ name: '  Niña   Dela Cruz ' });
    expect(failed).toEqual([]);
    expect(dto.name).toBe('Niña Dela Cruz');
  });

  it.each(['Juan2', '   ', 'a'.repeat(61), ''])('refuses the name %j', (name) => {
    expect(check({ name }).failed).toEqual(['name']);
  });

  it('normalises a PH mobile to E.164', () => {
    const { dto, failed } = check({ phone: '0917-123 4567' });
    expect(failed).toEqual([]);
    expect(dto.phone).toBe('+639171234567');
  });

  it.each(['0917abc4567', '(02) 8123 4567', '091712345'])('refuses the phone %j', (phone) => {
    expect(check({ phone }).failed).toEqual(['phone']);
  });

  it('turns a blank phone into null', () => {
    const { dto, failed } = check({ phone: '   ' });
    expect(failed).toEqual([]);
    expect(dto.phone).toBeNull();
  });

  it('trims a reference and holds it to 4–64 with a letter or digit', () => {
    expect(check({ reference: '  1234 ' }).dto.reference).toBe('1234');
    expect(check({ reference: '  12 ' }).failed).toEqual(['reference']);
    expect(check({ reference: '    ' }).failed).toEqual(['reference']);
    expect(check({ reference: '-----' }).failed).toEqual(['reference']);
    expect(check({ reference: 'x'.repeat(65) }).failed).toEqual(['reference']);
  });

  it('lets an amend send a blank reference to clear it', () => {
    expect(check({ amendReference: '   ' }).failed).toEqual([]);
    expect(check({ amendReference: '12' }).failed).toEqual(['amendReference']);
  });

  it('refuses a whitespace-only reason', () => {
    expect(check({ reason: '      ' }).failed).toEqual(['reason']);
    expect(check({ reason: '  ok then ' }).dto.reason).toBe('ok then');
  });

  // A number or an object where text belongs passes through the transform
  // untouched and is refused by IsString — a 400 from the pipe, never a 500.
  it.each([[42], [{ a: 1 }], [['x']], [true]])('refuses the non-string %j on a Trim field', (reason) => {
    expect(check({ reason }).failed).toEqual(['reason']);
  });

  it.each([[42], [{ a: 1 }]])('refuses the non-string %j for a name, phone or reference', (value) => {
    expect(check({ name: value }).failed).toEqual(['name']);
    expect(check({ phone: value }).failed).toEqual(['phone']);
    expect(check({ reference: value }).failed).toEqual(['reference']);
  });

  it('turns blank notes into null', () => {
    expect(check({ notes: '  ' }).dto.notes).toBeNull();
  });
});
