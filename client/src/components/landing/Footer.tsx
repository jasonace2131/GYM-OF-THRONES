import Image from 'next/image';
import Link from 'next/link';

const LINK_COLUMNS = [
  {
    heading: 'Explore',
    links: [
      { label: 'Services', href: '#services' },
      { label: 'Membership', href: '#membership' },
      { label: 'The Floor', href: '#floor' },
      { label: 'News', href: '#news' },
    ],
  },
  {
    heading: 'Visit',
    links: [
      { label: '4th Floor, JWMGI Building', href: '#contact' },
      { label: 'Taguig City, Philippines 1630', href: '#contact' },
      { label: '0966 205 9526', href: 'tel:+639662059526' },
      { label: 'gymofthrones2023@gmail.com', href: 'mailto:gymofthrones2023@gmail.com' },
    ],
  },
  {
    heading: 'Hours',
    links: [
      { label: 'Holidays · reduced hours', href: '#news' },
    ],
  },
] as const;

export default function Footer({ hours }: { hours: string[] }) {
  // The Hours column is assembled from live data, so the footer cannot
  // advertise a closing time the door will refuse. "Holidays · reduced hours"
  // survives because it is a standing caveat rather than a claim about a
  // specific time.
  const columns = LINK_COLUMNS.map((column) =>
    column.heading !== 'Hours'
      ? column
      : {
          heading: 'Hours',
          links: [
            ...hours.map((line) => ({ label: line, href: '#contact' })),
            ...column.links,
          ],
        },
  );

  return (
    <footer
      style={{
        background: 'var(--ground-2)',
        borderTop: '1px solid var(--line)',
        paddingTop: 'clamp(44px, 5vw, 64px)',
      }}
    >
      <div className="wrap">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(240px, 1.4fr) repeat(auto-fit, minmax(150px, 1fr))',
            gap: 'clamp(28px, 4vw, 56px)',
            paddingBottom: 40,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <Image
                src="/assets/logo.webp"
                alt="Gym of Thrones"
                width={44}
                height={44}
                style={{
                  borderRadius: '50%',
                  objectFit: 'cover',
                  border: '1.5px solid rgba(201,146,42,.5)',
                }}
              />
              <span>
                <span
                  style={{
                    display: 'block',
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 700,
                    fontSize: 16,
                    letterSpacing: '0.07em',
                    color: 'var(--text)',
                  }}
                >
                  GYM OF THRONES
                </span>
                <span
                  style={{
                    display: 'block',
                    fontSize: 9,
                    letterSpacing: '0.24em',
                    textTransform: 'uppercase',
                    color: 'var(--gold)',
                    marginTop: 2,
                  }}
                >
                  House of Fitness · Est 2023
                </span>
              </span>
            </div>
            <p
              style={{
                margin: '18px 0 0',
                fontSize: 13.5,
                lineHeight: 1.7,
                color: 'var(--text-3)',
                maxWidth: '38ch',
              }}
            >
              Metro Manila&apos;s house of fitness — equipment, coaching and a community that shows
              up. Where champions train.
            </p>
          </div>

          {columns.map((column) => (
            <div key={column.heading}>
              <div
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: 10.5,
                  fontWeight: 600,
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  color: 'var(--gold)',
                  marginBottom: 16,
                }}
              >
                {column.heading}
              </div>
              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                }}
              >
                {column.links.map((link) => (
                  <li key={link.label}>
                    <a href={link.href} className="flink">
                      {link.label}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>

        <hr className="hairline" />

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 14,
            padding: '20px 0 26px',
            fontSize: 12,
            color: 'var(--text-3)',
          }}
        >
          <span style={{ marginRight: 'auto' }}>
            © {new Date().getFullYear()} Gym of Thrones · All rights reserved
          </span>
          {/* These three pointed at `#contact` — the same in-page section as
              the phone number — so clicking "Waiver" scrolled you to a contact
              block and nothing else. Not a broken link, which QA would catch,
              but a link that appears to work and delivers nothing, which it
              does not. The documents exist now. */}
          <Link href="/privacy" className="flink">
            Privacy
          </Link>
          <Link href="/terms" className="flink">
            Terms
          </Link>
          <Link href="/waiver" className="flink">
            Waiver
          </Link>
        </div>
      </div>
    </footer>
  );
}
