import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.validation';
import type { BroadcastMessage } from './chat-broadcast';

/** Broadcast is a doorbell; a slow doorbell is not worth holding a socket for. */
const BROADCAST_TIMEOUT_MS = 5_000;

/**
 * Pushes saved chat messages to Supabase Realtime Broadcast — the live half
 * of the chat.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NEVER THE REASON A SEND FAILS.
 *
 * The message is already committed when this runs, and the client catches up
 * through the API on subscribe, reconnect and focus — Broadcast does not
 * guarantee delivery anyway. So `publish` is fire-and-forget: it returns at
 * once, and nothing it does can throw into the POST that called it.
 *
 * Without `SUPABASE_SERVICE_KEY` (it is optional in env.validation, like
 * member creation and GCash proofs) it warns ONCE and does nothing: chat still
 * works, it just is not instant.
 *
 * LOGS STATUS AND COUNTS ONLY. A broadcast carries a message body, which is
 * personal data, and a log line outlives the chat.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class RealtimeBroadcastService {
  private readonly logger = new Logger(RealtimeBroadcastService.name);
  private readonly endpoint: string;
  private readonly key: string | undefined;
  private warnedMissingKey = false;

  constructor(config: ConfigService<Env, true>) {
    const base = config.get('SUPABASE_URL', { infer: true }).replace(/\/+$/, '');
    this.endpoint = `${base}/realtime/v1/api/broadcast`;
    this.key = config.get('SUPABASE_SERVICE_KEY', { infer: true });
  }

  /** Fire and forget. Returns immediately; never throws, never rejects. */
  publish(messages: BroadcastMessage[]): void {
    void this.send(messages);
  }

  /** Resolves true when Supabase accepted the batch. Never rejects. */
  async send(messages: BroadcastMessage[]): Promise<boolean> {
    if (messages.length === 0) return false;

    if (this.key === undefined) {
      if (!this.warnedMissingKey) {
        this.warnedMissingKey = true;
        this.logger.warn(
          'SUPABASE_SERVICE_KEY unset — chat messages are saved but not pushed live; clients catch up on focus',
        );
      }
      return false;
    }

    try {
      const response = await fetch(this.endpoint, {
        method: 'POST',
        headers: {
          apikey: this.key,
          Authorization: `Bearer ${this.key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ messages }),
        signal: AbortSignal.timeout(BROADCAST_TIMEOUT_MS),
      });
      if (!response.ok) {
        this.logger.warn(
          `chat broadcast refused status=${response.status} messages=${messages.length}`,
        );
        return false;
      }
      return true;
    } catch (caught) {
      const kind = caught instanceof Error ? caught.name : typeof caught;
      this.logger.warn(`chat broadcast failed ${kind} messages=${messages.length}`);
      return false;
    }
  }
}
