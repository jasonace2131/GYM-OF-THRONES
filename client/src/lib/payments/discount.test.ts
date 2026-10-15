import { describe, expect, it } from 'vitest';
import { cleanDiscountInput, parseDiscount, percentOf, saleAmounts } from './discount';

describe('cleanDiscountInput', () => {
  it('keeps digits and one decimal point, two places at most', () => {
    expect(cleanDiscountInput('₱1,500.555')).toBe('1500.55');
    expect(cleanDiscountInput('1.2.3')).toBe('1.23');
    expect(cleanDiscountInput('abc')).toBe('');
  });
});

describe('parseDiscount', () => {
  it('takes a percentage of the list price, rounded half-up once', () => {
    expect(parseDiscount('PERCENT', '10', 150000)).toEqual({ kind: 'ok', centavos: 15000 });
    // 12.5% of ₱9.99 is 124.875 centavos → 125.
    expect(parseDiscount('PERCENT', '12.5', 999)).toEqual({ kind: 'ok', centavos: 125 });
  });

  it('reads a peso amount in pesos, never centavos', () => {
    expect(parseDiscount('AMOUNT', '150', 150000)).toEqual({ kind: 'ok', centavos: 15000 });
    expect(parseDiscount('AMOUNT', '0.5', 150000)).toEqual({ kind: 'ok', centavos: 50 });
  });

  it('treats an empty box as no entry rather than zero', () => {
    expect(parseDiscount('AMOUNT', '  ', 150000)).toEqual({ kind: 'empty' });
    expect(parseDiscount('PERCENT', '.', 150000)).toEqual({ kind: 'empty' });
  });

  it('refuses more than 100%, or more than the price', () => {
    expect(parseDiscount('PERCENT', '101', 150000).kind).toBe('invalid');
    expect(parseDiscount('AMOUNT', '1500.01', 150000).kind).toBe('invalid');
    expect(parseDiscount('AMOUNT', '1500', 150000)).toEqual({ kind: 'ok', centavos: 150000 });
  });
});

describe('saleAmounts', () => {
  it('takes a discretionary discount straight off the list price', () => {
    expect(
      saleAmounts({
        priceCentavos: 150000,
        discountType: 'PROMO',
        vatRegistered: null,
        operatorDiscountCentavos: 15000,
      }),
    ).toMatchObject({ grossCentavos: 150000, discountCentavos: 15000, netCentavos: 135000 });
  });

  it('computes a statutory discount itself and ignores any typed figure', () => {
    // Non-VAT seller: 20% of ₱90 = ₱18.
    expect(
      saleAmounts({
        priceCentavos: 9000,
        discountType: 'SENIOR',
        vatRegistered: false,
        operatorDiscountCentavos: 999,
      }),
    ).toMatchObject({ discountCentavos: 1800, netCentavos: 7200, vatExempt: false });
  });

  it('removes VAT first for a VAT-registered seller (RA 9994)', () => {
    // ₱1,500 / 1.12 = ₱1,339.29; 20% of that = ₱267.86; due ₱1,071.43.
    expect(
      saleAmounts({
        priceCentavos: 150000,
        discountType: 'PWD',
        vatRegistered: true,
        operatorDiscountCentavos: 0,
      }),
    ).toMatchObject({
      vatBaseCentavos: 133929,
      discountCentavos: 26786,
      netCentavos: 107143,
      vatExempt: true,
    });
  });

  it('shows no figure while the VAT status a statutory sale needs is loading', () => {
    expect(
      saleAmounts({
        priceCentavos: 150000,
        discountType: 'SENIOR',
        vatRegistered: null,
        operatorDiscountCentavos: 0,
      }),
    ).toBeNull();
  });

  it('treats an empty type as no discount', () => {
    expect(
      saleAmounts({
        priceCentavos: 9000,
        discountType: '',
        vatRegistered: null,
        operatorDiscountCentavos: 500,
      }),
    ).toMatchObject({ discountCentavos: 0, netCentavos: 9000 });
  });
});

describe('percentOf', () => {
  it('names the share of the price a peso discount is', () => {
    expect(percentOf(15000, 150000)).toBe('10%');
    expect(percentOf(10000, 150000)).toBe('6.67%');
    expect(percentOf(0, 150000)).toBeNull();
  });
});
