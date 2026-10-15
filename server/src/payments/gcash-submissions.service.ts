import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { ProofStorageService } from '../storage/proof-storage.service';
import { SystemNotificationsService } from '../notifications/system-notifications.service';
import { normalizeGcashReference } from './payment-reference';
import type { CreateGcashSubmissionDto } from './dto/gcash-submission.dto';

/** The wire shape a member sees of their own claim. */
export interface MyGcashSubmission {
  id: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  planCode: string;
  amountCentavos: number;
  reference: string;
  submittedAt: string;
  reviewedAt: string | null;
  rejectReason: string | null;
  /** Short-lived signed link to their own screenshot, or null if unavailable. */
  proofUrl: string | null;
}

/** What the review queue shows staff. Adds who submitted it. */
export interface GcashSubmissionForReview extends MyGcashSubmission {
  member: {
    userId: string;
    firstName: string;
    lastName: string;
    memberCode: string | null;
  };
  /** The plan's list price now, so staff can see a short payment at a glance. */
  planPriceCentavos: number | null;
  planName: string | null;
}

const QUEUE_LIMIT = 100;

/**
 * A member's claim that they sent money by GCash.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOTHING HERE CREATES A PAYMENT. Owner decision #9 is untouched: every peso
 * lands in a counted till against an open shift, entered by a person who saw
 * it. This service takes a claim and shows it to staff. `approve` hands the
 * actual sale to the existing membership-sales path, under the reviewing
 * operator's identity and their open shift, which is what writes the money.
 *
 * If you are tempted to make this service call `payment.create` directly to
 * save a hop: that hop IS the control.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class GcashSubmissionsService {
  private readonly logger = new Logger(GcashSubmissionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: ProofStorageService,
    private readonly notifications: SystemNotificationsService,
  ) {}

  /**
   * Mint a one-shot upload URL for this member's screenshot.
   *
   * Prefixed with the member's own id so an object can always be attributed
   * even if its row is lost, and so one member's uploads can never land in
   * another's folder. The PATH IS MINTED SERVER-SIDE — see `signUpload`.
   */
  async signUpload(userId: string, contentType: string) {
    return this.storage.signUpload(`members/${userId}`, contentType);
  }

  /**
   * Take the claim.
   *
   * The duplicate check spans BOTH tables, because a reference recycled from a
   * paid transfer into a new claim is the same fraud as recycling it into a
   * new payment — and the member-facing message says only that the reference
   * is already on file. It deliberately does NOT say when, or for how much:
   * that is somebody else's payment, and confirming its details to whoever
   * typed the number is the leak this endpoint would otherwise be.
   */
  async submit(
    userId: string,
    dto: CreateGcashSubmissionDto,
    now: Date = new Date(),
  ): Promise<MyGcashSubmission> {
    const referenceNormalized = normalizeGcashReference(dto.reference);
    if (referenceNormalized.length === 0) {
      throw new DomainException(
        'GCASH_REFERENCE_REQUIRED',
        'Enter the reference number from your GCash receipt.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const plan = await this.prisma.plan.findUnique({ where: { code: dto.planCode } });
    if (plan === null || !plan.isActive) {
      throw new DomainException(
        'PLAN_NOT_FOUND',
        'That plan is not on sale.',
        HttpStatus.NOT_FOUND,
      );
    }

    const alreadyPaid = await this.prisma.payment.findFirst({
      where: { referenceNormalized, method: 'GCASH', status: { not: 'VOIDED' } },
      select: { id: true },
    });
    if (alreadyPaid !== null) {
      throw new DomainException(
        'GCASH_REFERENCE_DUPLICATE',
        'That reference is already recorded against a payment. If you think this is wrong, show it at the front desk.',
        HttpStatus.CONFLICT,
      );
    }

    try {
      const row = await this.prisma.gcashSubmission.create({
        data: {
          userId,
          planCode: plan.code,
          amountCentavos: dto.amountCentavos,
          reference: dto.reference.trim(),
          referenceNormalized,
          proofPath: dto.proofPath,
          submittedAt: now,
        },
      });

      // Best-effort, after the row is committed — the same discipline the
      // contact form follows. A member's claim must survive the notice about
      // it failing.
      await this.notifications.raise({
        kind: 'GCASH_SUBMISSION',
        severity: 'WARNING',
        title: 'A member says they paid by GCash',
        body: `Reference ${row.reference} for ${plan.name}. Check the GCash Transactions tab, then approve or reject it.`,
        linkPath: '/admin/payments',
        subjectType: 'GcashSubmission',
        subjectId: row.id,
      });

      return this.toMine(row);
    } catch (caught) {
      // The partial unique index on PENDING rows. A double tap, or the same
      // screenshot sent again next week while the first is still waiting.
      if (caught instanceof Prisma.PrismaClientKnownRequestError && caught.code === 'P2002') {
        throw new DomainException(
          'GCASH_SUBMISSION_PENDING',
          'You have already sent us that reference and we are still checking it.',
          HttpStatus.CONFLICT,
        );
      }
      throw caught;
    }
  }

  /** This member's own claims, newest first. */
  async mine(userId: string): Promise<MyGcashSubmission[]> {
    const rows = await this.prisma.gcashSubmission.findMany({
      where: { userId },
      orderBy: { submittedAt: 'desc' },
      take: 20,
    });
    return Promise.all(rows.map((row) => this.toMine(row)));
  }

  /**
   * The staff review queue. Oldest pending FIRST, deliberately: a member who
   * submitted on Monday should not wait behind one who submitted this morning.
   */
  async queue(status: 'PENDING' | 'APPROVED' | 'REJECTED'): Promise<GcashSubmissionForReview[]> {
    const rows = await this.prisma.gcashSubmission.findMany({
      where: { status },
      orderBy: status === 'PENDING' ? { submittedAt: 'asc' } : { reviewedAt: 'desc' },
      take: QUEUE_LIMIT,
      include: {
        user: { select: { id: true, firstName: true, lastName: true, memberCode: true } },
      },
    });

    const codes = [...new Set(rows.map((row) => row.planCode))];
    const plans = await this.prisma.plan.findMany({
      where: { code: { in: codes } },
      select: { code: true, name: true, priceCentavos: true },
    });
    const planBy = new Map(plans.map((plan) => [plan.code, plan]));

    return Promise.all(
      rows.map(async (row) => ({
        ...(await this.toMine(row)),
        member: {
          userId: row.user.id,
          firstName: row.user.firstName,
          lastName: row.user.lastName,
          memberCode: row.user.memberCode,
        },
        planPriceCentavos: planBy.get(row.planCode)?.priceCentavos ?? null,
        planName: planBy.get(row.planCode)?.name ?? null,
      })),
    );
  }

  /**
   * Refuse a claim, with a reason the MEMBER reads.
   *
   * The reason is required and minimum three characters at the database, not
   * because prose is valuable but because "rejected" with no explanation is
   * how a member who really did pay decides to pay again.
   */
  async reject(
    id: string,
    actorId: string,
    reason: string,
    now: Date = new Date(),
  ): Promise<MyGcashSubmission> {
    const existing = await this.requirePending(id);
    void existing;

    // Conditional on still being PENDING, so two operators clicking at once
    // produce one decision and one no-op rather than two conflicting reviews.
    const claimed = await this.prisma.gcashSubmission.updateMany({
      where: { id, status: 'PENDING' },
      data: { status: 'REJECTED', reviewedAt: now, reviewedById: actorId, rejectReason: reason },
    });
    if (claimed.count !== 1) {
      throw new DomainException(
        'GCASH_SUBMISSION_ALREADY_REVIEWED',
        'Somebody else dealt with that one a moment ago.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const row = await this.prisma.gcashSubmission.findUniqueOrThrow({ where: { id } });
    return this.toMine(row);
  }

  /**
   * Claim a submission for approval, WITHOUT writing the payment.
   *
   * Returns what the caller needs to run the ordinary sale. The caller — the
   * controller, holding the operator's identity and their open shift — is what
   * actually sells, and then calls `attachPayment` below. Splitting it this way
   * is what keeps "only staff create money" true in code rather than in a
   * comment.
   */
  async requirePending(id: string) {
    const row = await this.prisma.gcashSubmission.findUnique({
      where: { id },
      include: { user: { select: { id: true, deletedAt: true } } },
    });

    if (row === null) {
      throw new DomainException(
        'GCASH_SUBMISSION_NOT_FOUND',
        'That submission does not exist.',
        HttpStatus.NOT_FOUND,
      );
    }
    if (row.status !== 'PENDING') {
      throw new DomainException(
        'GCASH_SUBMISSION_ALREADY_REVIEWED',
        'That submission has already been dealt with.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (row.user.deletedAt !== null) {
      throw new DomainException(
        'MEMBER_NOT_FOUND',
        'That member account is gone.',
        HttpStatus.NOT_FOUND,
      );
    }
    return row;
  }

  /**
   * Mark a claim approved once its payment exists.
   *
   * Copies the proof path onto the Payment as well, so "is there a receipt for
   * this payment" is one column to read whichever way the payment arrived.
   */
  async attachPayment(
    id: string,
    actorId: string,
    paymentId: string,
    proofPath: string,
    now: Date = new Date(),
  ): Promise<MyGcashSubmission> {
    const [row] = await this.prisma.$transaction([
      this.prisma.gcashSubmission.update({
        where: { id },
        data: { status: 'APPROVED', reviewedAt: now, reviewedById: actorId, paymentId },
      }),
      this.prisma.payment.update({ where: { id: paymentId }, data: { proofPath } }),
    ]);
    return this.toMine(row);
  }

  /** A signed link to one submission's image, or null when storage is off. */
  async proofUrl(path: string): Promise<string | null> {
    return this.storage.signView(path);
  }

  private async toMine(row: {
    id: string;
    status: string;
    planCode: string;
    amountCentavos: number;
    reference: string;
    submittedAt: Date;
    reviewedAt: Date | null;
    rejectReason: string | null;
    proofPath: string;
  }): Promise<MyGcashSubmission> {
    return {
      id: row.id,
      status: row.status as MyGcashSubmission['status'],
      planCode: row.planCode,
      amountCentavos: row.amountCentavos,
      reference: row.reference,
      submittedAt: row.submittedAt.toISOString(),
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      rejectReason: row.rejectReason,
      proofUrl: await this.storage.signView(row.proofPath),
    };
  }
}
