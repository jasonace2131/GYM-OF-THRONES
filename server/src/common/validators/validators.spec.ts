import { plainToInstance } from 'class-transformer';
import { IsOptional, IsString, validateSync } from 'class-validator';
import { IsGymDate } from './is-gym-date.validator';
import { ExactlyOne } from './exactly-one.validator';
import { IsCentavos } from './is-centavos.validator';

class DateDto {
  @IsGymDate()
  businessDate!: string;
}

@ExactlyOne(['memberId', 'guestName'])
class WalkInDto {
  @IsOptional()
  @IsString()
  memberId?: string;

  @IsOptional()
  @IsString()
  guestName?: string;
}

class MoneyDto {
  @IsCentavos(1, 100_000_000)
  grossCentavos!: number;
}

function errorsFor(cls: new () => object, payload: Record<string, unknown>): string[] {
  const dto = plainToInstance(cls, payload, { enableImplicitConversion: true });
  return validateSync(dto).flatMap((error) => Object.keys(error.constraints ?? {}));
}

describe('IsGymDate', () => {
  it('accepts a yyyy-mm-dd civil date', () => {
    expect(errorsFor(DateDto, { businessDate: '2026-08-18' })).toEqual([]);
  });

  it('rejects a full ISO timestamp', () => {
    // @IsDateString() would ACCEPT this, and a timestamp arriving where a
    // civil date is meant is exactly how the UTC+8 bug gets reintroduced.
    expect(errorsFor(DateDto, { businessDate: '2026-08-18T00:00:00Z' })).toEqual(['matches']);
  });

  it('rejects a single-digit month', () => {
    expect(errorsFor(DateDto, { businessDate: '2026-8-18' })).toEqual(['matches']);
  });

  it('rejects a slash-separated date', () => {
    expect(errorsFor(DateDto, { businessDate: '18/08/2026' })).toEqual(['matches']);
  });
});

describe('ExactlyOne', () => {
  it('accepts exactly one field present', () => {
    expect(errorsFor(WalkInDto, { memberId: 'aaaa' })).toEqual([]);
    expect(errorsFor(WalkInDto, { guestName: 'Juan' })).toEqual([]);
  });

  it('rejects both present — a walk-in is a member or a guest, never both', () => {
    expect(errorsFor(WalkInDto, { memberId: 'aaaa', guestName: 'Juan' })).toEqual(['exactlyOne']);
  });

  it('rejects neither present', () => {
    expect(errorsFor(WalkInDto, {})).toEqual(['exactlyOne']);
  });

  it('treats an empty string as absent', () => {
    expect(errorsFor(WalkInDto, { memberId: '', guestName: 'Juan' })).toEqual([]);
  });

  it('treats an explicit null as absent', () => {
    expect(errorsFor(WalkInDto, { memberId: null, guestName: null })).toEqual(['exactlyOne']);
  });
});

describe('IsCentavos', () => {
  it('accepts a realistic monthly price in integer centavos', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: 80000 })).toEqual([]);
  });

  it('accepts the walk-in price at the lower bound of a sale', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: 9000 })).toEqual([]);
  });

  it('rejects a fractional centavo', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: 8000.5 })).toEqual(['isInt']);
  });

  it('rejects zero when the bound says a gross must be positive', () => {
    // grossCentavos > 0 always: a ₱0 collection still carries the list price
    // it was discounted from.
    expect(errorsFor(MoneyDto, { grossCentavos: 0 })).toEqual(['min']);
  });

  it('rejects a value above the CHECK constraint ceiling', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: 100_000_001 })).toEqual(['max']);
  });

  it('coerces a numeric string, because the pipe converts before validating', () => {
    expect(errorsFor(MoneyDto, { grossCentavos: '220000' })).toEqual([]);
  });
});
