import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import { Observable, interval, map, merge } from 'rxjs';
import type { MessageEvent } from '@nestjs/common';
import type {
  ActiveCheckIn,
  CheckInRecord,
  CheckInResult,
  DeskFeedEvent,
  DeskTodayPayload,
  PaginatedData,
} from '@got/shared';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { DomainException } from '../common/exceptions/domain.exception';
import type { AuthUser } from '../auth/auth.types';
import { DeskFeedService } from '../checkin/desk-feed.service';
import { FrontDeskService } from './front-desk.service';
import { DeskCheckInService } from './desk-check-in.service';
import { WalkInService } from './walk-in.service';
import { CheckOutDto, CreateManualCheckInDto, VoidCheckInDto } from './dto/desk-check-in.dto';
import { SellWalkInDto } from './dto/sell-walk-in.dto';
import { ScanMemberCodeDto } from './dto/scan-member-code.dto';
import { OverrideDenialDto } from './dto/override-denial.dto';
import { MemberCodeIssuer } from '../checkin/member-code.issuer';
import { ClassesService } from '../classes/classes.service';
import type { ClassSessionDto } from '../classes/class.presenter';

/**
 * Ten seconds of dead air is a closed connection to most reverse proxies. A
 * gym opens at 05:00 and the console sits idle for stretches, so the heartbeat
 * is not an optimisation — without it the desk silently loses the feed and
 * nobody finds out until a denial goes unanswered.
 */
const HEARTBEAT_MS = 20_000;

@Controller('front-desk')
export class FrontDeskController {
  constructor(
    private readonly frontDesk: FrontDeskService,
    private readonly deskFeed: DeskFeedService,
    private readonly deskCheckIns: DeskCheckInService,
    private readonly walkIns: WalkInService,
    private readonly memberCodes: MemberCodeIssuer,
    private readonly classes: ClassesService,
  ) {}

  /**
   * Route 49 — the walk-in sale and the guest pass.
   *
   * `walkin.sell` is the one COMPOSITE key in the catalogue: this endpoint
   * both takes money and admits somebody, and `@RequirePermission` takes
   * exactly one key. Rather than weaken the guard with a "require any of"
   * variant — which would leave it unable to tell a scoped service which key
   * to resolve against — the registry's `requires` mechanism carries the
   * prerequisites (`payment.record`, `checkin.create`).
   *
   * The key is minted when the sheet OPENS, so a retry after a slow network is
   * free and a double-tap cannot charge twice.
   */
  @Post('walk-ins')
  @RequirePermission('walkin.sell')
  @Idempotent()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async sellWalkIn(
    @CurrentUser() operator: AuthUser,
    @Body() dto: SellWalkInDto,
    @Headers('idempotency-key') idempotencyKey: string,
  ): Promise<CheckInRecord> {
    return this.walkIns.sell(operator, dto, idempotencyKey);
  }

  /**
   * Route 45 — `F2 CHECK IN BY NAME`.
   *
   * THE WORD "FALLBACK" APPEARS NOWHERE STAFF CAN SEE. Per-visit self-scan
   * failure is realistically 15-30% of arrivals and worst at both peaks; a
   * path carrying a quarter of traffic at three times the transaction time is
   * a main road, and naming it an exception is how it ends up designed like
   * one.
   *
   * 60/60s, raised from the 30 every other desk write gets, precisely because
   * it is routine at peak rather than exceptional.
   */
  @Post('check-ins')
  @RequirePermission('checkin.create')
  @Idempotent()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async manualCheckIn(
    @CurrentUser() operator: AuthUser,
    @Body() dto: CreateManualCheckInDto,
  ): Promise<CheckInResult> {
    return this.deskCheckIns.record(operator, dto);
  }

  /**
   * The desk scans the member's own phone.
   *
   * THE FALLBACK FOR THE FALLBACK'S FAILURE MODE. The normal path is the
   * member scanning the station display, and its documented cost (§6.10) is
   * that the member's handset becomes a hard network dependency — a dead
   * access point or data switched off means no check-in at all. Here the
   * member's phone only has to have loaded a code, and staff supply the
   * connectivity.
   *
   * Verifies the signature and then delegates into route 45's service, so the
   * shift requirement, the photo/identity rule, the door ladder and the desk
   * feed are all the same code. Nothing about admission is decided here.
   *
   * Recorded as `method = MEMBER_CODE`, the same as a typed code. A new enum
   * value would mean a migration touching three biconditional CHECK
   * constraints, and the identity claim is the same one: possession of the
   * code. What the signature adds is freshness, not a stronger claim.
   */
  @Post('check-ins/scan')
  @RequirePermission('checkin.create')
  @Idempotent()
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async scanMemberCode(
    @CurrentUser() operator: AuthUser,
    @Body() dto: ScanMemberCodeDto,
  ): Promise<CheckInResult> {
    // Delegates by memberCode, NOT by userId. Route 45 derives the method from
    // which identifier it was handed, and a userId would record this as
    // MANUAL — "a staffer recognised them" — which is both the weaker identity
    // claim and not what happened.
    const { memberCode } = await this.memberCodes.resolveScan(dto.payload);

    const delegated = new CreateManualCheckInDto();
    delegated.memberCode = memberCode;
    if (dto.identityConfirmed !== undefined) delegated.identityConfirmed = dto.identityConfirmed;

    return this.deskCheckIns.record(operator, delegated);
  }

  /**
   * Route 48 — the manager override.
   *
   * `checkin.override`, the only key in the catalogue marked dangerous. Held by
   * ADMIN alone in the seeded grants, so a front-desk operator cannot admit a
   * lapsed member on their own say-so — they call somebody, and that somebody's
   * id lands on the row.
   */
  @Post('denials/:id/override')
  @RequirePermission('checkin.override')
  @Idempotent()
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async overrideDenial(
    @CurrentUser() operator: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: OverrideDenialDto,
  ): Promise<CheckInResult> {
    return this.deskCheckIns.overrideDenial(operator, id, dto);
  }

  /**
   * Route 51 — who is expected today.
   *
   * LEFT UNBUILT UNTIL NOW, ON PURPOSE. Before classes existed this question
   * had no honest answer: "expected" could only have meant every active member
   * or a guess from attendance history, and this project cuts what it cannot
   * source rather than shipping a plausible-looking list. Today's sessions are
   * the real answer.
   */
  @Get('roster')
  @RequirePermission('checkin.read')
  async roster(): Promise<ClassSessionDto[]> {
    return this.classes.roster();
  }

  /** Route 46 — the rail's power button. */
  @Post('check-ins/:id/checkout')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('checkin.close')
  async checkOut(
    @CurrentUser() operator: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CheckOutDto,
  ): Promise<CheckInRecord> {
    return this.deskCheckIns.checkOut(operator, id, dto.endedAt);
  }

  /**
   * Route 47 — void a visit. ADMIN only, `isDangerous`, and confirmed.
   *
   * The confirmation is checked HERE rather than in the DTO because
   * `confirm: false` is a client that asked without meaning it, which is a
   * different thing from `confirm` being absent or malformed.
   */
  @Post('check-ins/:id/void')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('checkin.void')
  async voidCheckIn(
    @CurrentUser() operator: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: VoidCheckInDto,
  ): Promise<CheckInRecord> {
    if (!dto.confirm) {
      throw new DomainException(
        'CONFIRMATION_REQUIRED',
        'Voiding a visit rewrites an attendance record. Confirm to proceed.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return this.deskCheckIns.void(operator, id, dto.reason);
  }

  /**
   * Route 50 — who is in the building, right now.
   *
   * Open visits only, ordered newest first. A member who forgot to scan out is
   * still on this board until the stale-visit rule or the nightly job closes
   * them, which is correct: the board's job is to say who the building thinks
   * is inside, not who actually is.
   */
  @Get('check-ins/active')
  @RequirePermission('checkin.read')
  async active(@Query() query: PaginationQueryDto): Promise<PaginatedData<ActiveCheckIn>> {
    return this.frontDesk.activeCheckIns(query);
  }

  /**
   * A guest's contact details, for the "Make member" hand-off — the one read
   * allowed past the `DeskMember` boundary, gated on the permission to create
   * the account the data is about to seed. See the service for the argument.
   */
  @Get('check-ins/:id/guest')
  @RequirePermission('member.create')
  async guestContact(@Param('id', ParseUUIDPipe) id: string): Promise<{
    guestName: string | null;
    guestPhone: string | null;
    guestEmail: string | null;
    guestEmergencyContact: string | null;
  }> {
    return this.frontDesk.guestContact(id);
  }

  /**
   * Route 52 — the feed's polling fallback AND its reconnect catch-up.
   *
   * Pass the previous response's `cursor` as `?since=` to get only what
   * changed. Omit it for a full day. A malformed cursor is ignored rather than
   * rejected — see the service.
   */
  @Get('today')
  @RequirePermission('checkin.read')
  async today(@Query('since') since?: string): Promise<DeskTodayPayload> {
    return this.frontDesk.today(since);
  }

  /**
   * The live denial feed (§8.5.1) — Server-Sent Events.
   *
   * ───────────────────────────────────────────────────────────────────────
   * FOUR THINGS HERE ARE LOAD-BEARING AND ALL FOUR FAIL SILENTLY IF DROPPED.
   *
   * 1. `X-Accel-Buffering: no`. nginx (and most PaaS routers) buffer a
   *    streaming response by default, so events arrive in batches when the
   *    buffer flushes — which on a quiet evening means a denial reaches the
   *    desk minutes after the member walked away. The header is the only way
   *    to turn that off from inside the application.
   *
   * 2. The heartbeat. A connection with no traffic for ~30-60 s is reaped by
   *    intermediaries, and the browser reconnects — but only if it notices.
   *    Twenty seconds is comfortably inside every default.
   *
   * 3. `@SkipThrottle()`. A long-lived connection is not a request; counting
   *    it against a per-minute limit throttles a console that reconnects a few
   *    times during a bad-wifi patch, which is precisely when the feed matters.
   *
   * 4. SSE over `fetch` + a `ReadableStream` reader, NOT `EventSource`.
   *    `EventSource` cannot set an `Authorization` header, and moving the
   *    token into a query string would put a bearer credential in every proxy
   *    access log between here and the desk.
   * ───────────────────────────────────────────────────────────────────────
   *
   * Supabase Realtime was rejected despite already being in the stack:
   * streaming attendance rows to a browser needs RLS policies nobody has
   * designed, and it would stand a second authorisation model beside
   * `PermissionsGuard` on the most sensitive tables in the schema. SSE keeps
   * one auth model and lets the server control the projection — the stream
   * carries `DeskMember`, never a raw row.
   *
   * NOTHING IS COLLAPSED OR DEDUPLICATED. A run of denials IS the signal — a
   * drifting station clock, a mis-set grace window, a dead access point — and
   * burying it means nobody notices for a week.
   */
  @Sse('stream')
  @RequirePermission('checkin.read')
  @SkipThrottle()
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache, no-transform')
  stream(): Observable<MessageEvent> {
    const events = this.deskFeed.stream.pipe(
      map((event: DeskFeedEvent): MessageEvent => ({ type: eventNameFor(event), data: event })),
    );

    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({
        type: 'heartbeat',
        // A payload rather than a bare `:` comment: Nest's SSE writer emits
        // typed events, and a client that has to special-case comment frames
        // is a client that will get it wrong.
        data: { at: new Date().toISOString() },
      })),
    );

    return merge(events, heartbeat);
  }
}

/**
 * The event names §8.5.1 names, derived from the outcome rather than stored —
 * one fact, one place. `sale` and `station` land with the walk-in and station
 * admin slices.
 */
function eventNameFor(event: DeskFeedEvent): string {
  switch (event.kind) {
    case 'DENIAL':
      return 'denial';
    case 'CHECK_OUT':
      return 'checkout';
    default:
      return 'checkin';
  }
}
