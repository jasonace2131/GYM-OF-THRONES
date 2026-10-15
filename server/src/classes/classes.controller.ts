import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { Idempotent } from '../common/decorators/idempotent.decorator';
import { ClassesService } from './classes.service';
import { BookingsService } from './bookings.service';
import type {
  ClassRegisterEntry,
  ClassSessionDto,
  MarkAttendanceResult,
  MyBooking,
} from './class.presenter';
import {
  AddMemberToClassDto,
  CancelClassSessionDto,
  CreateClassSessionDto,
  ListClassSessionsQueryDto,
  MarkAttendanceDto,
  RemoveFromClassDto,
  UpdateClassSessionDto,
} from './dto/class-session.dto';

/**
 * The timetable and the member's own bookings.
 *
 * `class.read` rather than `@Public()`: a timetable names coaches and hours,
 * which is the gym telling its members rather than the street. Every seeded
 * role holds it, so in practice this is "signed in" — but loosening it later
 * is one line, and tightening it once the marketing site depends on it is not.
 */
@Controller('class-sessions')
export class ClassesController {
  constructor(
    private readonly classes: ClassesService,
    private readonly bookings: BookingsService,
  ) {}

  @Get()
  @RequirePermission('class.read')
  async list(@Query() query: ListClassSessionsQueryDto): Promise<ClassSessionDto[]> {
    return this.classes.list(query);
  }

  @Get(':id')
  @RequirePermission('class.read')
  async findOne(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ClassSessionDto> {
    return this.classes.findOne(id);
  }

  /**
   * Book, join the waitlist, or take a freed seat the member was waiting for.
   *
   * A full class is NOT an error while its waitlist is open — being waitlisted
   * is a successful outcome the member needs told about, and the response says
   * which happened (and where in the queue). The refusals that remain are
   * member copy: the plan does not cover the class day, booking has not opened
   * yet, the waitlist has closed.
   */
  @Post(':id/bookings')
  @RequirePermission('booking.create')
  @Idempotent()
  async book(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<MyBooking> {
    return this.bookings.book(user.id, id);
  }

  @Delete(':id/bookings')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('booking.create')
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<MyBooking> {
    return this.bookings.cancel(user.id, id);
  }

  /** The register. `booking.read` — staff and coaches, never the member. */
  @Get(':id/register')
  @RequirePermission('booking.read')
  async register(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<ClassRegisterEntry[]> {
    return this.bookings.register(id);
  }
}

/**
 * Staff-side timetable management, and the desk's hand on who is in a class.
 *
 * Every write here takes its actor from `@CurrentUser()`, never from the body:
 * the actor is who the row records (`bookedById`, `cancelledById`,
 * `markedById`) and who a notice is never sent to, so it must be the verified
 * caller and nothing a request could name.
 */
@Controller('admin/class-sessions')
export class AdminClassesController {
  constructor(
    private readonly classes: ClassesService,
    private readonly bookings: BookingsService,
  ) {}

  @Post()
  @RequirePermission('class.manage')
  @Idempotent()
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateClassSessionDto,
  ): Promise<ClassSessionDto> {
    return this.classes.create(user.id, dto);
  }

  @Patch(':id')
  @RequirePermission('class.manage')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: UpdateClassSessionDto,
  ): Promise<ClassSessionDto> {
    return this.classes.update(id, dto, user.id);
  }

  /** Cancels rather than deletes — the bookings stay, and so does the reason. */
  @Post(':id/cancel')
  @RequirePermission('class.manage')
  async cancelSession(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: CancelClassSessionDto,
  ): Promise<ClassSessionDto> {
    return this.classes.cancel(id, dto.reason, user.id);
  }

  /**
   * The desk adds a member by hand (`booking.manage`, FRONT_DESK and ADMIN).
   *
   * POST and `@Idempotent()`, so the client's Idempotency-Key turns a
   * double-clicked confirm into one booking rather than two attempts. Answers
   * with the member's register row: BOOKED, or WAITLISTED with their place.
   */
  @Post(':id/bookings')
  @RequirePermission('booking.manage')
  @Idempotent()
  async addMember(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: AddMemberToClassDto,
  ): Promise<ClassRegisterEntry> {
    return this.bookings.addByStaff(user.id, id, dto.userId);
  }

  /**
   * The desk takes a member out, with a reason they are shown
   * (`booking.manage`).
   *
   * A POST with a body rather than a DELETE: the reason is required. 200, not
   * 201 — nothing is created. Not `@Idempotent()`: a replay finds the booking
   * already cancelled and is refused (BOOKING_CANCELLED), so it can never
   * remove anybody twice.
   */
  @Post('bookings/:bookingId/remove')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('booking.manage')
  async removeMember(
    @CurrentUser() user: AuthUser,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
    @Body() dto: RemoveFromClassDto,
  ): Promise<ClassRegisterEntry> {
    return this.bookings.removeByStaff(user.id, bookingId, dto.reason);
  }

  /** Marking the register; the entry records who marked it, and when. */
  @Post('bookings/:bookingId/attendance')
  @RequirePermission('booking.attend')
  async markAttendance(
    @CurrentUser() user: AuthUser,
    @Param('bookingId', new ParseUUIDPipe({ version: '4' })) bookingId: string,
    @Body() dto: MarkAttendanceDto,
  ): Promise<MarkAttendanceResult> {
    return this.bookings.markAttendance(user.id, bookingId, dto.attended);
  }
}
