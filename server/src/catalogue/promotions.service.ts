import { HttpStatus, Injectable } from '@nestjs/common';
import { PromotionKind, type Prisma, type Promotion } from '@prisma/client';
import { DiscountType } from '@got/shared';
import { PrismaService } from '../prisma/prisma.service';
import { DomainException } from '../common/exceptions/domain.exception';
import { toDateColumn, type CivilDate } from '../common/time/gym-time';

export interface PromotionQuote {
  code: string;
  label: string;
  /** Centavos off the list price, already rounded. */
  discountCentavos: number;
  /** What lands in `Payment.discountReason`, so a report can name the promo. */
  reason: string;
}

/**
 * Whether a promo code applies, and what it is worth.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT NEVER TOUCHES MONEY DIRECTLY. This service answers "how many centavos
 * off"; `computeAmounts` does the arithmetic and the CHECK constraints verify
 * it. A promo path that computed its own net would be a second place a peso
 * can be decided, and the day the two disagree the drawer stops reconciling.
 * ═══════════════════════════════════════════════════════════════════════════
 */
@Injectable()
export class PromotionsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Price a code against a plan, without consuming it.
   *
   * Deliberately separate from `redeem`: the counter needs to show a member
   * what they will pay BEFORE taking their money, and a quote that burned a
   * redemption would make an abandoned sale cost the gym a promo slot.
   */
  async quote(
    code: string,
    plan: { code: string; kind: string; priceCentavos: number },
    today: CivilDate,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<PromotionQuote> {
    const promotion = await tx.promotion.findUnique({ where: { code: code.toUpperCase() } });

    if (promotion === null || !promotion.isActive) {
      throw new DomainException(
        'PROMOTION_NOT_FOUND',
        'That promo code is not recognised.',
        HttpStatus.NOT_FOUND,
      );
    }

    /*
     * MEMBERS ONLY — the owner's decision, enforced where it cannot be
     * forgotten rather than left to whoever writes the next sale screen.
     *
     * A discount on a ₱90 day pass is worth less than the reconciliation
     * noise it puts in the drawer, and a walk-in is a stranger the gym has no
     * relationship to reward.
     */
    if (plan.kind === 'WALK_IN') {
      throw new DomainException(
        'PROMOTION_NOT_APPLICABLE',
        'Promo codes apply to memberships, not to walk-in day passes.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const day = toDateColumn(today);
    if (day < promotion.startsOn) {
      throw new DomainException(
        'PROMOTION_NOT_STARTED',
        `That code is valid from ${promotion.startsOn.toISOString().slice(0, 10)}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (day > promotion.endsOn) {
      throw new DomainException(
        'PROMOTION_EXPIRED',
        `That code expired on ${promotion.endsOn.toISOString().slice(0, 10)}.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    // Empty means every term plan; otherwise the plan must be named.
    if (promotion.planCodes.length > 0 && !promotion.planCodes.includes(plan.code)) {
      throw new DomainException(
        'PROMOTION_NOT_APPLICABLE',
        `That code does not apply to the ${plan.code} plan.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    if (promotion.maxRedemptions !== null && promotion.redeemedCount >= promotion.maxRedemptions) {
      throw new DomainException(
        'PROMOTION_EXHAUSTED',
        'That code has been fully redeemed.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    return {
      code: promotion.code,
      label: promotion.label,
      discountCentavos: discountFor(promotion, plan.priceCentavos),
      // Named, not just "PROMO", so the discount report says which campaign
      // cost what without joining back to this table.
      reason: `PROMO ${promotion.code} — ${promotion.label}`,
    };
  }

  /**
   * Spend one redemption. MUST run inside the sale's own transaction.
   *
   * A CONDITIONAL update, never read-then-write: two staff ringing the last
   * redemption at once would both read `redeemedCount = 99` and both proceed.
   * The `WHERE` carries the cap, so exactly one row is updated and the loser
   * gets a clean domain error rather than an over-issued promo.
   */
  async redeem(tx: Prisma.TransactionClient, code: string): Promise<void> {
    const { count } = await tx.promotion.updateMany({
      where: {
        code: code.toUpperCase(),
        isActive: true,
        OR: [
          { maxRedemptions: null },
          // Prisma cannot compare two columns, so the cap is re-read from the
          // row we already quoted against. The CHECK constraint is the
          // backstop if this ever drifts.
          { redeemedCount: { lt: await this.capFor(tx, code) } },
        ],
      },
      data: { redeemedCount: { increment: 1 } },
    });

    if (count === 0) {
      throw new DomainException(
        'PROMOTION_EXHAUSTED',
        'That code was fully redeemed while this sale was being rung up.',
        HttpStatus.CONFLICT,
      );
    }
  }

  private async capFor(tx: Prisma.TransactionClient, code: string): Promise<number> {
    const row = await tx.promotion.findUnique({
      where: { code: code.toUpperCase() },
      select: { maxRedemptions: true },
    });
    return row?.maxRedemptions ?? Number.MAX_SAFE_INTEGER;
  }
}

/**
 * Centavos off, rounded half-up, never more than the price.
 *
 * The clamp matters: `Payment_money_consistent` requires
 * `discountCentavos <= vatBaseCentavos`, so a ₱1,000 fixed promo on an ₱800
 * plan would otherwise be rejected by the database as a malformed row rather
 * than simply making the sale free.
 */
function discountFor(promotion: Promotion, priceCentavos: number): number {
  const raw =
    promotion.kind === PromotionKind.PERCENTAGE
      ? Math.round((priceCentavos * promotion.value) / 10_000)
      : promotion.value;

  return Math.min(raw, priceCentavos);
}

/** A promo always books as PROMO — never as a statutory type. */
export const PROMOTION_DISCOUNT_TYPE = DiscountType.PROMO;
