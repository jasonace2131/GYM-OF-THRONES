import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal/LegalDocument';
import '../legal.css';

export const metadata: Metadata = {
  title: 'Privacy Notice — Gym of Thrones',
  description:
    'How Gym of Thrones collects, uses, stores and protects member personal information under the Philippine Data Privacy Act (RA 10173).',
};

/**
 * DRAFT — REQUIRES REVIEW BY THE GYM'S LAWYER BEFORE IT GOES LIVE.
 *
 * Written against RA 10173 and its IRR. Two obligations shape it:
 *
 *  - consent must be "freely given, specific, informed" AND evidenced by
 *    recorded means, which is why acceptance writes a ConsentRecord rather
 *    than setting a boolean;
 *  - health information and photographs are SENSITIVE personal information
 *    under §3(l) and get a higher bar than a phone number, so §3 names them
 *    separately rather than folding them into a general list.
 *
 * §5 describes what the system actually does today. Do not add a claim here
 * that the code does not implement — an inaccurate privacy notice is a
 * compliance problem in itself, not merely marketing copy.
 */
export default function PrivacyPage() {
  return (
    <LegalDocument kind="PRIVACY" updated="1 September 2026">
      <p className="legal-lede">
        This notice explains what personal information Gym of Thrones collects about you, why we
        collect it, how long we keep it, and the rights you have over it under the Data Privacy Act
        of 2012 (Republic Act No. 10173).
      </p>

      <h2>1. Who is responsible</h2>
      <p>
        Gym of Thrones House of Fitness, 4th Floor, JWMGI Building, Taguig City, Philippines 1630,
        is the <strong>Personal Information Controller</strong> for the information described here.
      </p>
      <p>
        For any privacy question or request, contact us at{' '}
        <a href="mailto:gymofthrones2023@gmail.com">gymofthrones2023@gmail.com</a> or 0966 205 9526,
        or speak to staff at the counter.
      </p>

      <h2>2. What we collect</h2>
      <ul>
        <li>
          <strong>Identity and contact</strong> — name, email address, mobile number, date of birth,
          and your member code.
        </li>
        <li>
          <strong>Emergency contact</strong> — the name, number and relationship of someone we can
          call if you are hurt.
        </li>
        <li>
          <strong>Membership and payment</strong> — your plan, term dates, payment amounts, method
          and reference numbers, receipts, and any statutory discount applied.
        </li>
        <li>
          <strong>Senior citizen or PWD identification number</strong>, where you claim the
          statutory discount. We are required to record this for BIR reporting.
        </li>
        <li>
          <strong>Attendance</strong> — the date and time of each visit, and how you checked in.
        </li>
        <li>
          <strong>Technical</strong> — a one-way, salted hash of the network address a check-in came
          from. We deliberately never store the address itself.
        </li>
      </ul>

      <h3>Sensitive personal information</h3>
      <p>These get additional protection under §3(l) of the Act, and we collect them only with your consent:</p>
      <ul>
        <li>
          <strong>Health information</strong> — any condition, injury or limitation you choose to
          tell us so we can keep you safe.
        </li>
        <li>
          <strong>Body measurements</strong> — height, weight and any progress readings you record.
        </li>
        <li>
          <strong>Photograph</strong> — your member photo, where you provide one, and CCTV footage
          of the premises.
        </li>
      </ul>

      <h2>3. Why we use it, and on what basis</h2>
      <ul>
        <li>
          <strong>To provide membership</strong> — admitting you, managing your plan, taking
          payment, and running classes. Basis: performance of our contract with you.
        </li>
        <li>
          <strong>To keep you safe</strong> — emergency contact and health information. Basis: your
          consent, and protection of your vital interests.
        </li>
        <li>
          <strong>To meet legal obligations</strong> — BIR records for payments and statutory
          discounts. Basis: compliance with law.
        </li>
        <li>
          <strong>To secure the premises</strong> — CCTV, and detecting shared or misused member
          codes. Basis: our legitimate interests, balanced against your privacy.
        </li>
        <li>
          <strong>To tell you things you need to know</strong> — closures, schedule changes,
          renewal reminders. Basis: performance of our contract.
        </li>
      </ul>
      <p>
        <strong>We do not sell your personal information, and we do not profile you for
        advertising.</strong> We do not use automated decision-making that produces legal effects
        for you.
      </p>

      <h2>4. Who we share it with</h2>
      <p>We share only what is necessary, and only with:</p>
      <ul>
        <li>our staff, according to their role — front desk staff see less than management;</li>
        <li>our service providers, who process data on our instructions: our database and authentication host, our email provider, and our hosting platforms;</li>
        <li>emergency and medical services, if you are injured;</li>
        <li>government authorities, where the law requires it.</li>
      </ul>
      <p>
        Some of these providers store data outside the Philippines. Where they do, we rely on their
        contractual data-protection commitments.
      </p>

      <h2>5. What we deliberately do not show</h2>
      <p>
        The screen at the front desk shows staff only what they need to admit you: your name, photo,
        member code and whether your membership is valid. Your phone number, email, address, payment
        history, health notes and emergency contact are <strong>deliberately excluded</strong> from
        that display, because it faces a public counter for the whole day.
      </p>

      <h2>6. How long we keep it</h2>
      <ul>
        <li><strong>Membership and payment records</strong> — for the life of your membership and afterwards for as long as tax and accounting law requires.</li>
        <li><strong>Attendance records</strong> — for the life of your membership.</li>
        <li><strong>Check-in scan logs</strong> — deleted automatically within 24 hours.</li>
        <li><strong>Consent records</strong> — for as long as you are a member and a reasonable period after, since they evidence what you agreed to.</li>
        <li><strong>CCTV</strong> — overwritten on a rolling basis.</li>
      </ul>

      <h2>7. Your rights</h2>
      <p>Under the Data Privacy Act you have the right to:</p>
      <ul>
        <li><strong>be informed</strong> — which this notice provides;</li>
        <li><strong>access</strong> a copy of the personal information we hold about you;</li>
        <li><strong>correct</strong> anything inaccurate;</li>
        <li><strong>object</strong> to processing, or withdraw consent you previously gave;</li>
        <li><strong>erasure or blocking</strong>, where the information is unlawfully obtained, no longer necessary, or you have withdrawn consent;</li>
        <li><strong>data portability</strong> — a copy in a commonly used electronic format;</li>
        <li><strong>damages</strong>, where you suffer loss from a violation of your rights;</li>
        <li><strong>complain</strong> to the National Privacy Commission at <a href="https://privacy.gov.ph" rel="noopener noreferrer" target="_blank">privacy.gov.ph</a>.</li>
      </ul>
      <p>
        To exercise any of these, email us at{' '}
        <a href="mailto:gymofthrones2023@gmail.com">gymofthrones2023@gmail.com</a>. We will respond
        within a reasonable period. Note that withdrawing consent for health information may mean we
        can no longer safely provide coaching, and that we must keep payment records for the period
        tax law requires even after you leave.
      </p>

      <h2>8. How we protect it</h2>
      <p>
        Access is controlled by role, so staff see only what their job requires. Passwords are never
        stored by us — sign-in is handled by our authentication provider. Data is encrypted in
        transit. Network addresses are hashed with a secret salt so that even a copy of our database
        cannot be walked back to a real address.
      </p>

      <h2>9. Children</h2>
      <p>
        Members below 18 require a parent or guardian&rsquo;s consent, which is given as part of
        joining. We do not knowingly collect information from children below that age without it.
      </p>

      <h2>10. Changes</h2>
      <p>
        We may update this notice. When we make a change of substance we will publish a new version
        and ask you to review it the next time you sign in. The version and date are shown at the
        top of this page.
      </p>
    </LegalDocument>
  );
}
