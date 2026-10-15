import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { AuditAction } from '@prisma/client';
import { PaginationQueryDto } from '../../common/dto/pagination-query.dto';

/**
 * Three filters, and no free-text search.
 *
 * A `?search=` over `subjectLabel` and `reason` would be the obvious fourth,
 * and it is deliberately absent: reasons are staff-written prose about
 * members, and a substring search over them turns an accountability record
 * into a browsable dossier. The three filters below answer the questions an
 * audit screen is actually opened for — what happened, who did it, and what
 * happened to this one record.
 */
export class ListAuditQueryDto extends PaginationQueryDto {
  @IsOptional()
  @IsEnum(AuditAction)
  action?: AuditAction;

  @IsOptional()
  @IsUUID('4')
  actorId?: string;

  @IsOptional()
  @IsUUID('4')
  subjectId?: string;
}
