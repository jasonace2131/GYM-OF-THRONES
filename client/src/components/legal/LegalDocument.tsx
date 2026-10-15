import type { ReactNode } from 'react';
import Link from 'next/link';
import Image from 'next/image';
import { LEGAL_LABELS, LEGAL_ROUTES, LEGAL_VERSIONS, type LegalDocumentKind } from '@got/shared';

/**
 * The shell every legal document renders in.
 *
 * One component rather than three pages that each style themselves, because
 * the version stamp is the load-bearing part: `ConsentRecord.version` is
 * meaningless unless the reader can see which version they are reading. A
 * page that forgot to print it would look fine and be evidentially useless.
 *
 * These are `@Public()` in spirit — a prospective member must be able to read
 * the waiver BEFORE creating an account, and a link in the footer must work
 * for someone who has never signed in.
 */
export function LegalDocument({
  kind,
  updated,
  children,
}: {
  kind: LegalDocumentKind;
  /** Human date for the header. The machine-readable one is the version. */
  updated: string;
  children: ReactNode;
}) {
  const others = (Object.keys(LEGAL_ROUTES) as LegalDocumentKind[]).filter((k) => k !== kind);

  return (
    <main className="legal-root">
      <div className="legal-wrap">
        <Link href="/" className="legal-brand">
          <Image
            src="/assets/logo.webp"
            alt=""
            aria-hidden
            width={38}
            height={38}
            style={{ borderRadius: '50%', objectFit: 'cover', border: '1.5px solid var(--gold)' }}
          />
          <span>
            <span className="legal-brand-name">GYM OF THRONES</span>
            <span className="legal-brand-sub">House of Fitness</span>
          </span>
        </Link>

        <header className="legal-head">
          <h1>{LEGAL_LABELS[kind]}</h1>
          <p className="legal-meta">
            Version <strong>{LEGAL_VERSIONS[kind]}</strong> · Last updated {updated}
          </p>
        </header>

        <article className="legal-body">{children}</article>

        <footer className="legal-foot">
          <p>
            Gym of Thrones — House of Fitness
            <br />
            4th Floor, JWMGI Building, Taguig City, Philippines 1630
            <br />
            <a href="tel:+639662059526">0966 205 9526</a> ·{' '}
            <a href="mailto:gymofthrones2023@gmail.com">gymofthrones2023@gmail.com</a>
          </p>
          <nav className="legal-links">
            {others.map((k) => (
              <Link key={k} href={LEGAL_ROUTES[k]}>
                {LEGAL_LABELS[k]}
              </Link>
            ))}
            <Link href="/">Back to site</Link>
          </nav>
        </footer>
      </div>
    </main>
  );
}
