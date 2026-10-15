import { SetMetadata } from '@nestjs/common';

export const IDEMPOTENT_KEY = 'idempotent';

/**
 * The header the client wrapper sets on every POST. Lives beside the marker so
 * the whole contract — "mark the route, read the header" — is one file.
 *
 * Lower-case because Node normalises incoming header names.
 */
export const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Marks a route as replay-protected. Opt-in: IdempotencyInterceptor is global
 * and does nothing at all to a route without this marker.
 *
 * Applied to POST /memberships, /memberships/:id/renew, /payments,
 * /front-desk/walk-ins, /front-desk/check-ins and /shifts/:id/close as those
 * land. NOT applied to POST /api/v1/checkin — StationScan's
 * (userId, stationId, slot) unique claim is already its key, and a strictly
 * stronger one; honouring both would give two mechanisms that can disagree.
 */
export const Idempotent = (): MethodDecorator => SetMetadata(IDEMPOTENT_KEY, true);
