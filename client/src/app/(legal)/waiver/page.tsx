import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal/LegalDocument';
import '../legal.css';

export const metadata: Metadata = {
  title: 'Liability Waiver — Gym of Thrones',
  description:
    'Assumption of risk, release of liability and indemnity for members of Gym of Thrones, Taguig City.',
};

/**
 * DRAFT — REQUIRES REVIEW BY THE GYM'S LAWYER BEFORE IT GOES LIVE.
 *
 * Drafted from standard fitness-industry waiver structure: assumption of
 * risk, release, indemnity, medical self-declaration, severability. It is
 * modelled on common practice, not on Philippine case law, and no part of it
 * has been reviewed by counsel. Philippine courts read exculpatory clauses
 * against the party that drafted them (Civil Code art. 1377) and will not
 * enforce a waiver of liability for gross negligence or wilful acts
 * (art. 1171), which is why §4 says so explicitly rather than over-claiming.
 */
export default function WaiverPage() {
  return (
    <LegalDocument kind="WAIVER" updated="1 September 2026">
      <p className="legal-lede">
        Please read this document carefully. It affects your legal rights. By accepting it you
        confirm that you have read and understood it, and that you accept it voluntarily.
      </p>

      <h2>1. What this covers</h2>
      <p>
        This waiver applies to your use of the premises, equipment, facilities, classes, and
        coaching services of Gym of Thrones House of Fitness, at 4th Floor, JWMGI Building,
        Taguig City (&ldquo;the Gym&rdquo;). It applies every time you enter, not only on the day
        you accept it.
      </p>

      <h2>2. Assumption of risk</h2>
      <p>
        I understand that strength training, cardiovascular exercise, group classes and the use of
        gym equipment are physically demanding activities that carry an inherent risk of injury,
        and in rare cases of serious injury, permanent disability or death. Those risks include,
        without limitation:
      </p>
      <ul>
        <li>strains, sprains, fractures and injuries from lifting, dropping or misusing equipment;</li>
        <li>slips, trips and falls, including on wet or recently cleaned surfaces;</li>
        <li>cardiac events, heat exhaustion, dehydration and fainting;</li>
        <li>injury caused by the conduct of other members or guests;</li>
        <li>aggravation of an existing injury or medical condition.</li>
      </ul>
      <p>
        <strong>
          I voluntarily choose to take part with knowledge of these risks, and I accept them.
        </strong>{' '}
        I understand that no supervision is guaranteed, that I train at my own pace and judgement,
        and that I am responsible for stopping when I should.
      </p>

      <h2>3. Health declaration</h2>
      <p>
        I confirm that, to the best of my knowledge, I am in good health and physically able to
        take part in exercise. I have disclosed to the Gym any medical condition, injury,
        medication, pregnancy or physical limitation relevant to my safety, and I will tell staff
        promptly if that changes.
      </p>
      <p>
        I understand the Gym&rsquo;s staff are not medical practitioners and cannot give medical
        advice, and that the Gym has recommended I consult a physician before beginning any new
        exercise programme.
      </p>

      <h2>4. Release and indemnity</h2>
      <p>
        To the fullest extent permitted by Philippine law, I release Gym of Thrones, its owners,
        officers, employees, coaches and agents from liability for injury, loss or damage arising
        from my ordinary use of the premises, equipment or services, including loss or damage to
        personal property.
      </p>
      <p>
        I agree to indemnify the Gym against claims arising from my own act or omission, or that of
        a guest I bring in.
      </p>
      <p>
        <strong>This release does not, and cannot, cover everything.</strong> Nothing in this
        document excludes or limits liability for gross negligence, fraud, or wilful acts, or any
        liability that Philippine law does not permit to be excluded. Where a provision of this
        waiver cannot be enforced, it is that provision alone that fails.
      </p>

      <h2>5. Rules and staff instructions</h2>
      <p>
        I agree to follow the Gym&rsquo;s posted rules and reasonable staff instructions, to re-rack
        weights, to wipe down equipment after use, to wear appropriate footwear, and not to train
        under the influence of alcohol or drugs. The Gym may refuse or end access where conduct
        endangers people or property.
      </p>

      <h2>6. Photography and CCTV</h2>
      <p>
        The premises are monitored by CCTV for security. The Gym may photograph or film in shared
        areas for its own promotion. If you do not wish to appear in promotional material, tell any
        member of staff — this will not affect your membership. Handling of these recordings is
        described in our <a href="/privacy">Privacy Notice</a>.
      </p>

      <h2>7. Emergencies</h2>
      <p>
        I authorise the Gym to arrange emergency first aid or medical transport on my behalf if I
        am unable to consent at the time, and I accept responsibility for the cost of that care.
      </p>

      <h2>8. Minors</h2>
      <p>
        Members below 18 years of age may only join with the written consent of a parent or legal
        guardian, who accepts this waiver on the minor&rsquo;s behalf and remains responsible for
        their conduct while on the premises.
      </p>

      <h2>9. Severability and governing law</h2>
      <p>
        If any part of this waiver is found to be unenforceable, the remainder continues in full
        force — in particular, my acknowledgement of risk in §2 survives independently of the
        release in §4. This waiver is governed by the laws of the Republic of the Philippines, and
        the courts of Taguig City have jurisdiction over any dispute.
      </p>

      <h2>10. Acceptance</h2>
      <p>
        Accepting this document in the Gym of Thrones app records the date, time and version you
        agreed to. That record is kept for as long as you remain a member and for a reasonable
        period afterwards, as described in our <a href="/privacy">Privacy Notice</a>. You may ask
        for a copy at any time.
      </p>
    </LegalDocument>
  );
}
