import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { PaymentVoidKind } from '@prisma/client';
import { VoidPaymentDto } from './void-payment.dto';

function parse(payload: Record<string, unknown>): { dto: VoidPaymentDto; constraints: string[] } {
  const dto = plainToInstance(VoidPaymentDto, payload, { enableImplicitConversion: true });
  const constraints = validateSync(dto).flatMap((error) => Object.keys(error.constraints ?? {}));
  return { dto, constraints };
}

const VALID = { reason: 'rang the wrong plan', confirm: true, kind: PaymentVoidKind.VOID };

describe('VoidPaymentDto', () => {
  it('accepts a valid VOID payload', () => {
    expect(parse(VALID).constraints).toEqual([]);
  });

  it('accepts a valid REFUND payload', () => {
    expect(parse({ ...VALID, kind: PaymentVoidKind.REFUND }).constraints).toEqual([]);
  });

  it('rejects a missing kind', () => {
    const { kind: _omit, ...rest } = VALID;
    expect(parse(rest).constraints).toEqual(['isEnum']);
  });

  it('rejects an invented value — never hand-copy enum members', () => {
    // REFUNDED (past tense) is exactly the kind of invented value this repo
    // has been burned by before; the enum is imported from @prisma/client so
    // this can only fail if a real member set is ever added or removed there.
    expect(parse({ ...VALID, kind: 'REFUNDED' }).constraints).toEqual(['isEnum']);
  });

  it('still enforces the pre-existing reason length (3-200)', () => {
    expect(parse({ ...VALID, reason: 'ab' }).constraints).toEqual(['isLength']);
    expect(parse({ ...VALID, reason: 'a'.repeat(201) }).constraints).toEqual(['isLength']);
  });
});
