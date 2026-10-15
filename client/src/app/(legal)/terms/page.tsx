import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal/LegalDocument';
import '../legal.css';

export const metadata: Metadata = {
  title: 'Terms of Membership — Gym of Thrones',
  description:
    'Membership terms for Gym of Thrones, Taguig City: billing, renewal, grace period, freezing, cancellation and house rules.',
};

/**
 * DRAFT — REQUIRES REVIEW BY THE GYM'S LAWYER BEFORE IT GOES LIVE.
 *
 * Every operational number here is stated in words rather than interpolated
 * from GymConfigService on purpose: this is a contract, and a clause whose
 * meaning changes when an environment variable changes is not one a member
 * can rely on or a court can read. When a value below stops matching the
 * running configuration, the fix is to bump the version and re-prompt — not
 * to make the document self-updating.
 */
export default function TermsPage() {
  return (
    <LegalDocument kind="TERMS" updated="1 September 2026">
      <p className="legal-lede">
        These terms govern membership of Gym of Thrones — House of Fitness. They form an agreement
        between you and the Gym from the moment you accept them.
      </p>

      <h2>1. Membership</h2>
      <p>
        Membership is personal and non-transferable. Your member code and QR code identify you and
        must not be shared. Letting another person enter on your membership may end it without
        refund.
      </p>
      <p>
        We currently offer a walk-in day pass and monthly, quarterly and annual memberships. Current
        prices are shown on our website and at the counter, and are inclusive of any applicable VAT.
      </p>

      <h2>2. Payment</h2>
      <p>
        Membership is paid in advance, in cash or by GCash, at the counter. A membership begins on
        the day it is paid for and runs for the full term of the plan. We issue a receipt for every
        payment; please keep it.
      </p>
      <p>
        <strong>Senior citizens and persons with disability</strong> are entitled by law
        (RA 9994 and RA 10754) to a 20% discount and VAT exemption on membership. Present your OSCA
        or PWD identification at the counter and we will apply it. This is a statutory right, not a
        promotion, and it cannot be combined with a promotional discount — you receive whichever is
        applied, and the statutory discount always takes precedence.
      </p>

      <h2>3. Renewal</h2>
      <p>
        Memberships do <strong>not</strong> auto-renew and we do not store card details or take
        recurring payments. Your membership simply ends on its end date unless you renew it at the
        counter. We will remind you as the date approaches.
      </p>

      <h2>4. Grace period</h2>
      <p>
        For a short period after your membership ends you may still be admitted while you arrange a
        renewal. The length of that grace period and the number of admissions allowed within it are
        set by the Gym and shown to staff at check-in. Grace is a courtesy, not an entitlement, and
        it may be refused.
      </p>

      <h2>5. Freezing</h2>
      <p>
        Where your plan allows it, you may ask to freeze your membership — for example for illness,
        injury or travel. A freeze must be requested at the counter and approved by management, has
        a minimum and maximum length, is capped per year, and may carry a fee. Freezing pauses your
        end date; it does not extend a membership retroactively, and a freeze cannot be applied to a
        period that has already passed.
      </p>

      <h2>6. Cancellation and refunds</h2>
      <p>
        You may cancel at any time by telling staff at the counter. Cancellation stops any future
        renewal.
      </p>
      <p>
        <strong>Paid membership fees are not generally refundable</strong>, because a membership is
        access made available to you for a term rather than a service consumed per visit. We may, at
        our discretion, refund or credit a membership where the Gym is closed for an extended period,
        where a member cannot train for documented medical reasons, or where a payment was taken in
        error. Day passes are not refundable once the member has entered the premises.
      </p>

      <h2>7. Classes and bookings</h2>
      <p>
        Class places are limited and allocated in the order booked. Where a class is full you may
        join the waitlist and will be promoted automatically if a place is released. Please cancel a
        booking you cannot attend so the place can go to somebody else; repeated no-shows may lead
        to booking restrictions.
      </p>

      <h2>8. Guests</h2>
      <p>
        Guests are welcome on a day pass, or on a guest pass if your plan includes them. A guest must
        accept the liability waiver before entering and remains your responsibility while on the
        premises.
      </p>

      <h2>9. House rules</h2>
      <ul>
        <li>Re-rack weights and wipe equipment down after use.</li>
        <li>Wear closed athletic footwear and a shirt on the training floor.</li>
        <li>Do not drop or slam weights except in designated areas.</li>
        <li>Share equipment during busy periods; do not reserve stations you are not using.</li>
        <li>No training under the influence of alcohol or drugs.</li>
        <li>Lockers are for use during your visit only; the Gym is not responsible for property left in them.</li>
      </ul>

      <h2>10. Suspension and termination</h2>
      <p>
        We may suspend or end a membership, without refund, for conduct that endangers people or
        property, for harassment or abuse of members or staff, for theft, or for repeated breach of
        these terms. Where circumstances allow we will warn you first.
      </p>

      <h2>11. Opening hours and closures</h2>
      <p>
        Opening hours are published on our website and at the Gym and may change. We may close for
        maintenance, holidays or events, and will give notice where we reasonably can. Short
        closures do not extend a membership term.
      </p>

      <h2>12. Changes to these terms</h2>
      <p>
        We may update these terms. When we make a change of substance we will publish a new version
        and ask you to accept it the next time you sign in. Continuing to use the Gym after a change
        means you accept it. Your existing paid term is honoured at the price and duration you paid
        for.
      </p>

      <h2>13. Your data</h2>
      <p>
        How we handle your personal information — including your photo, attendance and any health
        information you give us — is set out in our <a href="/privacy">Privacy Notice</a>. Your use
        of the Gym is also subject to our <a href="/waiver">Liability Waiver</a>.
      </p>

      <h2>14. Governing law</h2>
      <p>
        These terms are governed by the laws of the Republic of the Philippines. Disputes are
        subject to the jurisdiction of the courts of Taguig City. If any clause is found
        unenforceable, the rest remain in force.
      </p>
    </LegalDocument>
  );
}
