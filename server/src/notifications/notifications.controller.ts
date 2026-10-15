import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Length, Max, Min } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import type { AuthUser } from '../auth/auth.types';
import { SystemNotificationsService } from './system-notifications.service';
import type { NotificationCounts, SystemNotificationView } from './notification.presenter';

/**
 * Read off the RAW query object, not off the implicitly converted value.
 *
 * `enableImplicitConversion` coerces by the reflected design type, and for a
 * `boolean` that turns the string 'false' into `true` — so `?unreadOnly=false`
 * would silently mean the opposite of what it says. `ListCoachAssignmentsQueryDto`
 * documents the same trap; this is the same fix.
 */
const boolFrom = (key: string) =>
  Transform(({ obj }) => {
    const raw = (obj as Record<string, unknown>)[key];
    if (raw === undefined || raw === null || raw === '') return false;
    return raw === true || raw === 'true';
  });

export class NotificationSearchDto {
  /** Title or body, any case. */
  @IsOptional()
  @IsString()
  @Length(1, 64)
  search?: string;
}

export class ListNotificationsQueryDto extends NotificationSearchDto {
  @boolFrom('unreadOnly')
  @IsOptional()
  @IsBoolean()
  unreadOnly: boolean = false;

  @boolFrom('includeResolved')
  @IsOptional()
  @IsBoolean()
  includeResolved: boolean = false;

  /** Only archived notices. Wins over the two flags above. */
  @boolFrom('archived')
  @IsOptional()
  @IsBoolean()
  archived: boolean = false;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  /** Defaults to the old cap, so a caller that sends no limit sees no change. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit: number = 100;
}

export class MarkAllReadDto {}

/**
 * The Notifications panel's stored half — Figure 22, REQ021.
 *
 * The panel's OTHER column, Expiration Alerts, has no route here and never
 * will: it is the same `GET /memberships?expiringWithinDays=` the Subscriptions
 * screen already runs, and a second endpoint returning the same rows under a
 * different name is a second thing to keep correct. See the header of
 * `system-notification.prisma` for the full argument.
 *
 * `notification.read` gates the list; `notification.resolve` gates every write.
 * Split because seeing that an enquiry came in and claiming it has been dealt
 * with are different acts — and because a future read-only role should be
 * expressible without also being able to clear the board.
 */
@Controller('admin/notifications')
export class NotificationsController {
  constructor(private readonly notifications: SystemNotificationsService) {}

  @Get()
  @RequirePermission('notification.read')
  async list(@Query() query: ListNotificationsQueryDto): Promise<SystemNotificationView[]> {
    return this.notifications.list(query);
  }

  @Get('counts')
  @RequirePermission('notification.read')
  async counts(@Query() query: NotificationSearchDto): Promise<NotificationCounts> {
    return this.notifications.counts(query.search);
  }

  @Post(':id/read')
  @RequirePermission('notification.resolve')
  async markRead(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<SystemNotificationView> {
    return this.notifications.markRead(id, user.id);
  }

  @Post(':id/resolve')
  @RequirePermission('notification.resolve')
  async resolve(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<SystemNotificationView> {
    return this.notifications.resolve(id, user.id);
  }

  /** Undo an archive. The console calls resolving "Archive". */
  @Post(':id/restore')
  @RequirePermission('notification.resolve')
  async restore(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<SystemNotificationView> {
    return this.notifications.restore(id);
  }

  /**
   * There is no "resolve all" counterpart, deliberately. Marking a column seen
   * is a claim anybody can honestly make; marking forty enquiries dealt with in
   * one click is not.
   *
   * Takes an empty body DTO rather than no body at all: `forbidNonWhitelisted`
   * is global, so this is what makes a stray property a 400 instead of a
   * silently ignored one.
   */
  @Post('read-all')
  @RequirePermission('notification.resolve')
  async markAllRead(
    @CurrentUser() user: AuthUser,
    @Body() _body: MarkAllReadDto,
  ): Promise<{ changed: number }> {
    return this.notifications.markAllRead(user.id);
  }
}
