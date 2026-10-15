import { Injectable, Logger } from '@nestjs/common';
import type { OwnerSummaryPayload } from './reports.service';

/**
 * §5.9.4's one-method seam. Email in v1 is a provider swap, not a rewrite —
 * Viber and SMS are the same one method.
 */
export interface SummaryTransport {
  send(payload: OwnerSummaryPayload): Promise<void>;
}

export const SUMMARY_TRANSPORT = 'SUMMARY_TRANSPORT';

/**
 * The v1 implementation: one structured line, machine-readable, with no
 * formatted currency anywhere — a missing line at 03:15 IS the alert until a
 * real transport lands.
 */
@Injectable()
export class LoggingSummaryTransport implements SummaryTransport {
  private readonly logger = new Logger('OwnerSummary');

  send(payload: OwnerSummaryPayload): Promise<void> {
    this.logger.log(JSON.stringify(payload));
    return Promise.resolve();
  }
}
