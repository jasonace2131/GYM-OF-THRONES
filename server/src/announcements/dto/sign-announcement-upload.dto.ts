import { IsIn, IsInt, Max, Min } from 'class-validator';
import { ANNOUNCEMENT_IMAGE_MAX_BYTES, ANNOUNCEMENT_IMAGE_TYPES } from '@got/shared';

/**
 * `POST /admin/announcements/uploads`.
 *
 * The browser declares what it is about to upload so the server can refuse it
 * before minting a URL. The bucket enforces the same type and size limits on
 * the bytes themselves; this is the first line, not the only one. No path is
 * accepted: the server mints it.
 */
export class SignAnnouncementUploadDto {
  @IsIn([...ANNOUNCEMENT_IMAGE_TYPES], { message: 'Attach a JPEG, PNG or WebP image.' })
  contentType!: string;

  @IsInt()
  @Min(1)
  @Max(ANNOUNCEMENT_IMAGE_MAX_BYTES, { message: 'That image is over 5 MB.' })
  size!: number;
}
