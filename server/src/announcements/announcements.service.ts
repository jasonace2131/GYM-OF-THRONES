import { HttpStatus, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  Announcement,
  AnnouncementDoc,
  AnnouncementImageUpload,
  AnnouncementUploadStatus,
  PaginatedData,
} from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import type { AuthUser } from '../auth/auth.types';
import { DomainException } from '../common/exceptions/domain.exception';
import { paginated, paginationSkipTake } from '../common/dto/paginate';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import { AnnouncementImageStorageService } from '../storage/announcement-image-storage.service';
import { ANNOUNCEMENT_ORDER, AUTHOR_SELECT, toAnnouncement } from './announcement.presenter';
import type { CreateAnnouncementDto } from './dto/create-announcement.dto';
import type { SignAnnouncementUploadDto } from './dto/sign-announcement-upload.dto';
import type { UpdateAnnouncementDto } from './dto/update-announcement.dto';
import { isAnnouncementImageUrl, sanitizeAnnouncementDoc } from './rich-content';

/**
 * Announcements are unscoped on purpose.
 *
 * One gym, one noticeboard: every member with `announcement.read` sees all of
 * it, so nothing here takes a `ScopedWhere` while every membership and payment
 * read does. There is no per-member audience, and adding one later would be a
 * scope filter here rather than a change of shape.
 */

/** A body resolved from the DTO: the plain text to store, and the JSON (or null). */
interface ResolvedBody {
  content: string;
  contentJson: AnnouncementDoc | null;
}

const invalid = (message: string): DomainException =>
  new DomainException('ANNOUNCEMENT_CONTENT_INVALID', message, HttpStatus.BAD_REQUEST);

@Injectable()
export class AnnouncementsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly images: AnnouncementImageStorageService,
  ) {}

  /** The member feed and the admin list are the same query. */
  async list(query: PaginationQueryDto): Promise<PaginatedData<Announcement>> {
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.announcement.findMany({
        include: { author: AUTHOR_SELECT },
        orderBy: ANNOUNCEMENT_ORDER,
        ...paginationSkipTake(query),
      }),
      this.prisma.announcement.count(),
    ]);

    return paginated(rows.map(toAnnouncement), total, query);
  }

  async findOne(id: string): Promise<Announcement> {
    const row = await this.prisma.announcement.findUnique({
      where: { id },
      include: { author: AUTHOR_SELECT },
    });

    if (row === null) throw new NotFoundException('Announcement not found');
    return toAnnouncement(row);
  }

  async create(actor: AuthUser, dto: CreateAnnouncementDto): Promise<Announcement> {
    // Validated BEFORE the write: a refused document leaves nothing behind.
    const body = this.resolveBody(dto);
    if (body === undefined) throw invalid('Write a message.');
    const cover = this.resolveCover(dto.coverImageUrl) ?? null;

    const row = await this.prisma.announcement.create({
      data: {
        title: dto.title,
        content: body.content,
        // Omitted rather than DbNull for a plain notice: NULL is the column default.
        ...(body.contentJson === null ? {} : { contentJson: asJson(body.contentJson) }),
        coverImageUrl: cover,
        isPinned: dto.isPinned ?? false,
        authorId: actor.id,
      },
      include: { author: AUTHOR_SELECT },
    });

    await this.audit.record({
      action: 'ANNOUNCEMENT_CREATED',
      actorId: actor.id,
      actorRole: actor.role,
      subjectType: 'Announcement',
      subjectId: row.id,
      subjectLabel: row.title,
      details: {
        isPinned: row.isPinned,
        format: body.contentJson === null ? 'plain' : 'rich',
        coverImage: cover !== null,
      },
    });

    return toAnnouncement(row);
  }

  /**
   * The author is NOT reassigned on edit.
   *
   * A notice edited by an admin still says who wrote it. Overwriting the author
   * with whoever last touched a typo would quietly rewrite the record of who
   * told members the gym was closing early.
   *
   * Pin and unpin come through here too, so they are audited as updates with
   * `isPinned` before and after.
   */
  async update(id: string, dto: UpdateAnnouncementDto, actor: AuthUser): Promise<Announcement> {
    // Read first: a missing row is a 404 rather than Prisma's P2025, and the
    // audit entry needs the before state.
    const existing = await this.prisma.announcement.findUnique({ where: { id } });
    if (existing === null) throw new NotFoundException('Announcement not found');

    const body = this.resolveBody(dto);
    const cover = this.resolveCover(dto.coverImageUrl);

    const row = await this.prisma.announcement.update({
      where: { id },
      data: {
        ...(dto.title === undefined ? {} : { title: dto.title }),
        ...(body === undefined
          ? {}
          : {
              content: body.content,
              contentJson: body.contentJson === null ? Prisma.DbNull : asJson(body.contentJson),
            }),
        ...(cover === undefined ? {} : { coverImageUrl: cover }),
        ...(dto.isPinned === undefined ? {} : { isPinned: dto.isPinned }),
      },
      include: { author: AUTHOR_SELECT },
    });

    /*
     * WHAT CHANGED, NOT WHAT IT SAYS NOW. The title and the pin carry before
     * and after — both are short, public, and exactly what someone asks about
     * ("who pinned that?"). The body is named but never copied: the audit
     * log is not a second copy of the noticeboard.
     */
    const fields: string[] = [];
    const details: Record<string, unknown> = {};
    if (dto.title !== undefined && dto.title !== existing.title) {
      fields.push('title');
      details['title'] = { before: existing.title, after: dto.title };
    }
    if (
      body !== undefined &&
      (body.content !== existing.content ||
        stableJson(body.contentJson) !== stableJson(existing.contentJson))
    ) {
      fields.push('body');
    }
    if (cover !== undefined && cover !== existing.coverImageUrl) fields.push('coverImage');
    if (dto.isPinned !== undefined && dto.isPinned !== existing.isPinned) {
      fields.push('isPinned');
      details['isPinned'] = { before: existing.isPinned, after: dto.isPinned };
    }

    if (fields.length > 0) {
      await this.audit.record({
        action: 'ANNOUNCEMENT_UPDATED',
        actorId: actor.id,
        actorRole: actor.role,
        subjectType: 'Announcement',
        subjectId: row.id,
        subjectLabel: row.title,
        details: { fields, ...details },
      });
    }

    return toAnnouncement(row);
  }

  /**
   * A hard delete, and that is the right call here.
   *
   * An announcement is not a financial record: nothing references it, no
   * report reconciles against it, and a member who reads a notice that was
   * withdrawn a month ago is worse served than one who cannot find it at all.
   * Payments and check-ins are soft-deleted precisely because the opposite is
   * true of them.
   *
   * Its images are not removed here. The nightly orphan cleanup takes any
   * bucket object no notice references once it is a day old, which also
   * covers images dropped by an edit and uploads that were never posted.
   */
  async remove(id: string, actor: AuthUser): Promise<Announcement> {
    const existing = await this.findOne(id);
    await this.prisma.announcement.delete({ where: { id } });

    await this.audit.record({
      action: 'ANNOUNCEMENT_DELETED',
      actorId: actor.id,
      actorRole: actor.role,
      subjectType: 'Announcement',
      subjectId: existing.id,
      subjectLabel: existing.title,
      details: {
        isPinned: existing.isPinned,
        format: existing.contentJson === null ? 'plain' : 'rich',
      },
    });

    return existing;
  }

  /** Whether the composer may offer images at all. */
  uploadStatus(): AnnouncementUploadStatus {
    return { enabled: this.images.enabled };
  }

  signUpload(dto: SignAnnouncementUploadDto): Promise<AnnouncementImageUpload> {
    return this.images.signUpload(dto.contentType, dto.size);
  }

  /**
   * The body the request asks for, or undefined when it does not touch it.
   *
   * `contentJson` goes through the allowlist and yields the plain `content` to
   * store beside it; plain `content` alone yields a plain notice. Both at once
   * is refused rather than guessed at: for a rich notice `content` is derived,
   * and a caller-supplied copy could only disagree with the JSON.
   */
  private resolveBody(
    dto: CreateAnnouncementDto | UpdateAnnouncementDto,
  ): ResolvedBody | undefined {
    const hasPlain = dto.content !== undefined && dto.content !== null;

    if (dto.contentJson !== undefined) {
      if (hasPlain) throw invalid('Send the message as contentJson or as content, not both.');
      const result = sanitizeAnnouncementDoc(dto.contentJson, {
        imageBaseUrl: this.images.publicBaseUrl,
      });
      if (!result.ok) throw invalid(result.reason);
      return { content: result.text, contentJson: result.doc };
    }

    return hasPlain ? { content: dto.content as string, contentJson: null } : undefined;
  }

  /** undefined leaves the cover alone, null removes it, a string must be one of ours. */
  private resolveCover(value: string | null | undefined): string | null | undefined {
    if (value === undefined || value === null) return value;
    if (!isAnnouncementImageUrl(value, this.images.publicBaseUrl)) {
      throw invalid(
        'The cover image must be uploaded here — an image from anywhere else is refused.',
      );
    }
    return value;
  }
}

function asJson(doc: AnnouncementDoc): Prisma.InputJsonValue {
  return doc as unknown as Prisma.InputJsonValue;
}

/**
 * JSON with object keys sorted, so a document read back from jsonb (which
 * reorders keys) compares equal to the same document built in memory. Only
 * ever given sanitised documents, so the recursion is bounded.
 */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}
