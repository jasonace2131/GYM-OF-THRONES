'use client';

import Link from 'next/link';
import { CONTACT_ITEMS, GYM_LOCATION } from '@/lib/landingData';
import ContactForm from './ContactForm';

/** The tiles render with `white-space: pre-line`, so this stacks the days. */
const NEWLINE = String.fromCharCode(10);

export default function ContactSection({ hours }: { hours: string[] }) {
  return (
    <section id="contact" className="sec grid-tex" style={{ background: 'var(--ground)' }}>
      <div className="wrap" style={{ position: 'relative', zIndex: 1 }}>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))',
            gap: 'clamp(28px, 4vw, 56px)',
            alignItems: 'start',
          }}
        >
          {/* Left — where to find us */}
          <div>
            <div className="rv">
              <span className="eyebrow">Find us</span>
              <h2 className="h-sec">
                VISIT <em>US</em>
              </h2>
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
                gap: 1,
                marginTop: 30,
                border: '1px solid var(--line)',
                borderRadius: 12,
                overflow: 'hidden',
                background: 'var(--line)',
              }}
            >
              {[
                ...CONTACT_ITEMS,
                // Hours come from the same table the door reads, so this tile
                // cannot advertise an hour the gate will refuse. Omitted
                // entirely when the API is unreachable — a wrong opening time
                // is what sent somebody to a locked door in the first place.
                ...(hours.length === 0
                  ? []
                  : [{ label: 'Hours', value: hours.join(NEWLINE), href: null } as const]),
              ].map((item) => {
                // A tile with somewhere to go renders as an anchor. These
                // were all plain divs, so tapping the phone number on a
                // phone — the single most likely action on this section —
                // did nothing at all.
                const Tag = (item.href === null ? 'div' : 'a') as 'div';
                return (
                <Tag
                  key={item.label}
                  {...(item.href === null
                    ? {}
                    : {
                        href: item.href,
                        ...(item.href.startsWith('http')
                          ? { target: '_blank', rel: 'noopener noreferrer' }
                          : {}),
                      })}
                  className="glow rv"
                  style={{
                    background: 'var(--ground-2)',
                    padding: '22px 20px',
                    transition: 'background .25s',
                    display: 'block',
                  }}
                >
                  <div
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: '0.2em',
                      textTransform: 'uppercase',
                      color: 'var(--gold)',
                      marginBottom: 10,
                    }}
                  >
                    {item.label}
                  </div>
                  <div
                    style={{
                      fontSize: 14,
                      lineHeight: 1.6,
                      color: 'var(--text)',
                      whiteSpace: 'pre-line',
                    }}
                  >
                    {item.value}
                  </div>
                </Tag>
                );
              })}
            </div>

            {/*
              A "VISIT US" section with no map is the one thing this block was
              missing, and it matters more here than for most gyms: this is a
              4th-floor unit inside a building, so the address alone gets
              somebody to a lobby and no further.

              Google's plain `?q=&output=embed` form needs no API key and no
              billing account. It DOES load Google's own scripts into the
              landing page, which is why it is lazy — it costs nothing until
              somebody scrolls to it — and why the privacy notice names our
              service providers.
            */}
            <div className="visit-map">
              <iframe
                title="Map showing Gym of Thrones in Taguig City"
                src={`https://www.google.com/maps?q=${encodeURIComponent(GYM_LOCATION.query)}&output=embed`}
                loading="lazy"
                referrerPolicy="no-referrer-when-downgrade"
                allowFullScreen
              />
            </div>

            <p className="visit-directions">{GYM_LOCATION.directions}</p>

            {/*
              The escape hatch. An embedded map cannot start navigation, and
              somebody reading this on a phone outside the building wants
              turn-by-turn, not a picture of a street.
            */}
            <a
              className="btn btn-outline-gold visit-directions-cta"
              href={`https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(GYM_LOCATION.query)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              GET DIRECTIONS
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" aria-hidden>
                <path
                  d="M5 12h14M13 6l6 6-6 6"
                  stroke="currentColor"
                  strokeWidth="2.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </a>
          </div>

          {/* Right — the form. This was a marketing card whose only two
              controls were links to /register and /login, so the section
              named "contact" captured nothing. The card's job — convert the
              ready — is kept as the footer below the form; the form's job is
              everybody else. */}
          <div
            className="glow rv"
            style={{
              position: 'relative',
              overflow: 'hidden',
              borderRadius: 16,
              border: '1px solid rgba(201,146,42,.32)',
              background:
                'radial-gradient(120% 90% at 50% 0%, rgba(201,146,42,.17), transparent 60%), linear-gradient(165deg, #1c1913 0%, #101014 100%)',
              boxShadow: '0 30px 70px rgba(0,0,0,.6), 0 0 90px -30px var(--gold-glow)',
              padding: 'clamp(26px, 3.2vw, 40px)',
            }}
          >
            <span className="eyebrow">Send us a message</span>
            <h3
              style={{
                fontFamily: 'var(--font-heading)',
                fontWeight: 800,
                fontSize: 'clamp(22px, 2.6vw, 30px)',
                lineHeight: 1.1,
                margin: '12px 0 6px',
                color: '#fff',
              }}
            >
              ASK US <span style={{ color: 'var(--gold-lit)' }}>ANYTHING</span>
            </h3>
            <p
              style={{
                margin: '0 0 22px',
                fontSize: 14,
                lineHeight: 1.6,
                color: 'var(--text-2)',
              }}
            >
              Rates, trials, class schedules leave your details and we will get back to you.
            </p>

            <ContactForm />

            <div className="cform-alt">
              <span>Ready to join?</span>
              <Link id="contact-cta-btn" href="/register" className="btn btn-gold">
                CREATE ACCOUNT
              </Link>
              <Link href="/login" className="cform-alt-signin">
                Already a member? Sign in
              </Link>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
