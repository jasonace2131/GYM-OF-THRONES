import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject } from 'rxjs';
import type { DeskFeedEvent } from '@got/shared';

/**
 * The after-commit publish seam (§6.9). §8 owns the pixels; this owns the
 * guarantee.
 *
 * WHAT §6 GUARANTEES, and what this class is therefore not allowed to do:
 *
 *   - **The event is emitted AFTER the row commits.** Publishing inside the
 *     transaction would put a denial on the desk that a rollback then erases,
 *     and staff would be walking towards a member the database says never
 *     tried. Callers enforce this by calling `publish` outside
 *     `prisma.$transaction`, never in it.
 *   - **It carries the staff-directive message that never travelled to the
 *     member's phone.** Two audiences, two transports, two different HTTP
 *     responses.
 *   - **Nothing is collapsed or deduplicated.** A run of denials IS the
 *     signal — a drifting station clock, a mis-set grace window, a dead access
 *     point — and burying it means nobody notices for a week. There is
 *     deliberately no debounce, no distinctUntilChanged and no "same member
 *     within N seconds" filter anywhere in this file.
 *
 * WHY AN RXJS SUBJECT AND NOT EventEmitter2. Nest's `@Sse()` consumes an
 * `Observable` directly, rxjs is already a dependency of every Nest install,
 * and `@nestjs/event-emitter` would be a package added to reach a seam one
 * import already reaches. The transport decision (SSE, not Supabase Realtime)
 * is §6.0.2's and is not revisited here: streaming attendance rows to a
 * browser would need RLS policies this project has not designed, and would put
 * a second authorisation model beside `PermissionsGuard` on the most sensitive
 * tables in the schema.
 *
 * SUBJECT, NOT ReplaySubject. A late subscriber gets nothing, and that is
 * correct: reconnect catch-up is `GET /front-desk/today?since=`, a database
 * read that survives a server restart. A replay buffer here would be a second,
 * lossier answer to the same question — and the one that silently disagrees
 * after a deploy.
 */
@Injectable()
export class DeskFeedService {
  private readonly logger = new Logger(DeskFeedService.name);
  private readonly events = new Subject<DeskFeedEvent>();

  /**
   * Call AFTER commit, never inside the transaction.
   *
   * Never throws: a failure to notify the desk must not fail a check-in that
   * already committed. The member is through the door either way, and the
   * console's polling fallback closes the gap within seconds.
   */
  publish(event: DeskFeedEvent): void {
    try {
      this.events.next(event);
    } catch (error) {
      this.logger.error(`Desk feed publish failed for ${event.kind}`, error as Error);
    }
  }

  /** What `GET /front-desk/stream` subscribes to. */
  get stream(): Observable<DeskFeedEvent> {
    return this.events.asObservable();
  }
}
