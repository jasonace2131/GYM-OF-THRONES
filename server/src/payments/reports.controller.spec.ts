import { REQUIRE_PERMISSION_KEY } from '../rbac/decorators/require-permission.decorator';
import { ReportsController } from './reports.controller';

/**
 * Which key opens each `/reports/*` route.
 *
 * Asserted on the metadata directly: a dropped or swapped decorator fails no
 * behavioural test, and the whole point of `revenue.read` is that the desk,
 * which keeps `payment.read`, can no longer read revenue.
 *
 * Owner decision (2026-09-25): the front desk loses the Revenue tab and keeps
 * Reports exactly as it is, peso figures included — so every other route
 * stays on `payment.read`.
 */
describe('ReportsController permissions', () => {
  // Reading metadata off the function objects, never calling them.
  /* eslint-disable @typescript-eslint/unbound-method */
  const proto = ReportsController.prototype;
  const keyOf = (handler: (...args: never[]) => unknown): unknown =>
    Reflect.getMetadata(REQUIRE_PERMISSION_KEY, handler);

  it('gates revenue and recurring on revenue.read', () => {
    expect(keyOf(proto.revenue)).toBe('revenue.read');
    expect(keyOf(proto.recurring)).toBe('revenue.read');
  });

  it('keeps every Reports route the desk uses on payment.read', () => {
    expect(keyOf(proto.statutoryDiscounts)).toBe('payment.read');
    expect(keyOf(proto.gcash)).toBe('payment.read');
    expect(keyOf(proto.dailySummary)).toBe('payment.read');
    expect(keyOf(proto.walkIns)).toBe('payment.read');
    expect(keyOf(proto.memberships)).toBe('payment.read');
    expect(keyOf(proto.statutoryCsv)).toBe('payment.read');
  });
  /* eslint-enable @typescript-eslint/unbound-method */
});
