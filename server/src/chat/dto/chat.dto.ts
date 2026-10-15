import { Transform, Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Length, Max, Min } from 'class-validator';
import { CHAT_MESSAGE_MAX_LENGTH } from '@got/shared';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';
import { CHAT_PAGE_MAX } from '../chat-page';

const trimmed = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;

export class SendChatMessageDto {
  /**
   * Plain text. Trimmed at the edges (line breaks inside are kept), then
   * 1-2000 characters — the same bounds as `ChatMessage_body_length`.
   */
  @Transform(trimmed)
  @IsString()
  @Length(1, CHAT_MESSAGE_MAX_LENGTH)
  body!: string;

  /**
   * The sender's optimistic id for this message. NOT stored: it is echoed in
   * the response and the broadcast so the sender's own tabs can swap their
   * pending bubble for the saved one instead of showing it twice.
   */
  @IsOptional()
  @IsUUID()
  clientId?: string;
}

/** At most one of `before` / `after`; neither means the newest page. */
export class ListChatMessagesQueryDto {
  @IsOptional()
  @IsUUID()
  before?: string;

  @IsOptional()
  @IsUUID()
  after?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(CHAT_PAGE_MAX)
  limit?: number;
}

/** `chat.review`: why an admin is reading somebody else's conversation. */
export class ReviewChatThreadDto {
  @Transform(trimmed)
  @IsString()
  @Length(5, 500)
  reason!: string;
}

export class ListReviewThreadsQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsUUID()
  memberId?: string;

  @IsOptional()
  @IsUUID()
  coachId?: string;
}
