import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { IsIn, IsOptional } from 'class-validator';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { RequirePermission } from '../rbac/decorators/require-permission.decorator';
import { DomainException } from '../common/exceptions/domain.exception';
import type { AuthUser } from '../auth/auth.types';
import { PrismaService } from '../prisma/prisma.service';
import {
  GcashSubmissionsService,
  type GcashSubmissionForReview,
  type MyGcashSubmission,
} from './gcash-submissions.service';
import {
  CreateGcashSubmissionDto,
  RejectGcashSubmissionDto,
  SignProofUploadDto,
} from './dto/gcash-submission.dto';
import type { SignedUpload } from '../storage/proof-storage.service';

export class QueueQueryDto {
  @IsOptional()
  @IsIn(['PENDING', 'APPROVED', 'REJECTED'])
  status: 'PENDING' | 'APPROVED' | 'REJECTED' = 'PENDING';
}

/**
 * The member's own side: "I sent you the money, here is the receipt."
 *
 * Keyless, like the rest of `/me` — the subject is `request.user.id` and there
 * is no parameter that could name anybody else. A CLIENT holds no payment
 * permission and needs none: this endpoint does not touch money. It records a
 * CLAIM, which a member is entitled to make about themselves.
 */
@Controller('me/gcash')
export class MeGcashController {
  constructor(private readonly submissions: GcashSubmissionsService) {}

  /**
   * Step one: get a one-shot URL and upload the screenshot straight to
   * storage.
   *
   * The image never passes through this API. A few hundred KB per submission
   * has no business travelling through a request pipeline built to validate
   * DTOs, and a direct upload means a slow phone on gym wifi is not holding a
   * Nest worker open while it finishes.
   */
  @Post('upload-url')
  @HttpCode(HttpStatus.OK)
  async uploadUrl(
    @CurrentUser() user: AuthUser,
    @Body() dto: SignProofUploadDto,
  ): Promise<SignedUpload> {
    return this.submissions.signUpload(user.id, dto.contentType);
  }

  /** Step two: the claim itself, naming the object just uploaded. */
  @Post('submissions')
  async submit(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateGcashSubmissionDto,
  ): Promise<MyGcashSubmission> {
    /*
     * THE OWNERSHIP CHECK, and it is the reason `proofPath` can be accepted
     * from a client at all.
     *
     * The DTO proves the path has the shape this server issues. This proves it
     * is the caller's OWN folder — without it, a member could paste another
     * member's object path and attach somebody else's receipt to their claim.
     * The prefix is minted in `signUpload` from the same id, so the two cannot
     * drift.
     */
    if (!dto.proofPath.startsWith(`members/${user.id}/`)) {
      throw new ForbiddenException('That image does not belong to this account.');
    }
    return this.submissions.submit(user.id, dto);
  }

  /** What I have sent, and what happened to it. */
  @Get('submissions')
  async mine(@CurrentUser() user: AuthUser): Promise<MyGcashSubmission[]> {
    return this.submissions.mine(user.id);
  }
}

/**
 * The staff side: the review queue.
 *
 * `payment.read` to look and `payment.record` to decide, rather than keys of
 * their own. Approving a claim is the act of recording money, so the person
 * who may do it is exactly the person who may record a payment — and inventing
 * a parallel key would let the two drift until somebody could approve claims
 * without being trusted to take money.
 */
@Controller('admin/gcash-submissions')
export class AdminGcashSubmissionsController {
  constructor(
    private readonly submissions: GcashSubmissionsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  @RequirePermission('payment.read')
  async queue(@Query() query: QueueQueryDto): Promise<GcashSubmissionForReview[]> {
    return this.submissions.queue(query.status);
  }

  /**
   * Link a claim to the payment staff already recorded for it.
   *
   * ═══════════════════════════════════════════════════════════════════════
   * THIS DOES NOT CREATE THE PAYMENT, AND THAT IS THE POINT.
   *
   * The order is: staff find the reference in the gym's own GCash
   * Transactions tab, record the sale through the ordinary counter flow
   * (against their open shift, with the attestation they always tick), and
   * THEN approve. This route finds that payment by its reference and links it.
   *
   * So there is no path anywhere in this system where a member's submission
   * mints money. Owner decision #9 survives intact, and a reviewer who
   * approves something they never found in GCash still had to record a payment
   * under their own name to do it.
   * ═══════════════════════════════════════════════════════════════════════
   *
   * The payment is looked up by the claim's own normalized reference rather
   * than taken as a parameter: a `paymentId` in the body would let a careless
   * client link a claim to an unrelated sale, and there would be nothing in
   * the data to say it was wrong.
   */
  @Post(':id/approve')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payment.record')
  async approve(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<MyGcashSubmission> {
    const claim = await this.submissions.requirePending(id);

    const payment = await this.prisma.payment.findFirst({
      where: {
        referenceNormalized: claim.referenceNormalized,
        method: 'GCASH',
        status: { not: 'VOIDED' },
      },
      select: { id: true },
    });

    if (payment === null) {
      throw new DomainException(
        'GCASH_PAYMENT_NOT_RECORDED',
        'Record the payment first with this reference, then approve — approving is the link, not the sale.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return this.submissions.attachPayment(id, user.id, payment.id, claim.proofPath);
  }

  @Post(':id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('payment.record')
  async reject(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() dto: RejectGcashSubmissionDto,
  ): Promise<MyGcashSubmission> {
    return this.submissions.reject(id, user.id, dto.reason);
  }
}
