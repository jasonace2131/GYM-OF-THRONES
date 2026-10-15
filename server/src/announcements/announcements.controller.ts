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
import type {
  Announcement,
  AnnouncementImageUpload,
  AnnouncementUploadStatus,
  PaginatedData,
} from '@got/shared';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { AuthUser } from '../auth/auth.types';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AnnouncementsService } from './announcements.service';
import { CreateAnnouncementDto } from './dto/create-announcement.dto';
import { SignAnnouncementUploadDto } from './dto/sign-announcement-upload.dto';
import { UpdateAnnouncementDto } from './dto/update-announcement.dto';

/**
 * The member-facing noticeboard.
 *
 * `announcement.read` rather than `@Public()`: a notice can name a closure, a
 * price change or a staffing detail the gym tells its members and not the
 * street. Every seeded role holds the key at ALL, CLIENT included, so this is
 * "signed in" rather than a real restriction — but it is the correct default,
 * and loosening it later is a one-line change while tightening it after the
 * marketing site depends on it is not.
 */
@Controller('announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Get()
  @RequirePermission('announcement.read')
  async list(@Query() query: PaginationQueryDto): Promise<PaginatedData<Announcement>> {
    return this.announcements.list(query);
  }

  @Get(':id')
  @RequirePermission('announcement.read')
  async findOne(@Param('id', ParseUUIDPipe) id: string): Promise<Announcement> {
    return this.announcements.findOne(id);
  }
}

/**
 * Writing to the noticeboard.
 *
 * One `@RequirePermission` key per route — the decorator resolves with
 * `getAllAndOverride`, so a method-level key REPLACES a class-level one rather
 * than ANDing with it, and a class-level key here would be silently discarded.
 *
 * Only ADMIN holds create/update/delete in the seeded grants. Nothing here is
 * scoped: there is one noticeboard, and an admin editing another admin's
 * notice is the normal case rather than an escalation.
 */
@Controller('admin/announcements')
export class AdminAnnouncementsController {
  constructor(private readonly announcements: AnnouncementsService) {}

  @Post()
  @RequirePermission('announcement.create')
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateAnnouncementDto,
  ): Promise<Announcement> {
    // The author is the caller, never a body field. A client-supplied authorId
    // would let an admin post in somebody else's name.
    return this.announcements.create(user, dto);
  }

  /**
   * Whether the composer may offer images. `announcement.create`, the key the
   * upload itself needs — a caller who cannot upload is told "disabled"
   * implicitly by the 403 and the editor hides the buttons either way.
   */
  @Get('uploads')
  @RequirePermission('announcement.create')
  uploadStatus(): AnnouncementUploadStatus {
    return this.announcements.uploadStatus();
  }

  /**
   * A one-shot signed URL for one image, and the public URL to insert.
   *
   * 200, not 201: nothing exists yet — the object appears only when the
   * browser PUTs to the URL, and one that is never posted in a notice is
   * removed by the nightly cleanup after a day. The path is minted by the
   * server; the body names only the type and size about to be sent.
   */
  @Post('uploads')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('announcement.create')
  async signUpload(@Body() dto: SignAnnouncementUploadDto): Promise<AnnouncementImageUpload> {
    return this.announcements.signUpload(dto);
  }

  @Patch(':id')
  @RequirePermission('announcement.update')
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateAnnouncementDto,
  ): Promise<Announcement> {
    return this.announcements.update(id, dto, user);
  }

  /**
   * Returns the deleted row rather than 204.
   *
   * The console renders "Deleted: <title>" and offers nothing further; a bare
   * 204 would force it to remember what it just removed in order to say so.
   */
  @Delete(':id')
  @RequirePermission('announcement.delete')
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<Announcement> {
    return this.announcements.remove(id, user);
  }
}
