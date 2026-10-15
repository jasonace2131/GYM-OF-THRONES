'use client';

import Image from 'next/image';
import { SERVICES } from '@/lib/landingData';

export default function ServicesSection() {
  return (
    <section id="services" className="sec grid-tex" style={{ background: 'var(--ground)' }}>
      <div
        className="spot"
        style={{
          width: 520,
          height: 520,
          left: '-12%',
          top: '18%',
          background: 'rgba(201,146,42,0.10)',
        }}
      />

      <div className="wrap" style={{ position: 'relative', zIndex: 1 }}>
        {/* Sticky heading rail + card field. The asymmetry is the point:
            nothing here is centred, so the eye tracks left-to-right
            instead of straight down a column. */}
        <div className="split">
          <div className="rail rv">
            <span className="eyebrow">What we offer</span>
            <h2 className="h-sec">
              OUR
              <br />
              <em>SERVICES</em>
            </h2>
            <p className="lede">
              Four ways to train, one membership. Walk in, pick your floor, and get to work.
            </p>
            <a
              href="#membership"
              className="btn btn-outline-gold"
              style={{ marginTop: 26, padding: '12px 24px', fontSize: 13, letterSpacing: '0.1em' }}
            >
              SEE PLANS
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

          <div className="svc-grid">
            {SERVICES.map((service) => (
              <article key={service.no} className="gcard glow rv">
                <div style={{ position: 'relative', height: 208, overflow: 'hidden' }}>
                  <Image
                    src={service.img}
                    alt={service.title}
                    fill
                    sizes="(max-width: 600px) 100vw, (max-width: 1080px) 50vw, 36vw"
                    className="gcard-img"
                    style={{ objectFit: 'cover' }}
                  />
                  {/* Scrim keeps the label readable and ties the photo
                      into the card body instead of stopping dead. */}
                  <div
                    style={{
                      position: 'absolute',
                      inset: 0,
                      background:
                        'linear-gradient(to bottom, rgba(11,11,13,.15) 0%, rgba(11,11,13,.55) 62%, var(--raised) 100%)',
                    }}
                  />
                  <span
                    style={{
                      position: 'absolute',
                      top: 14,
                      left: 14,
                      fontFamily: 'var(--font-heading)',
                      fontSize: 11,
                      fontWeight: 700,
                      letterSpacing: '0.18em',
                      color: 'var(--gold-lit)',
                      background: 'rgba(11,11,13,.6)',
                      border: '1px solid rgba(201,146,42,.4)',
                      backdropFilter: 'blur(6px)',
                      padding: '4px 10px',
                      borderRadius: 4,
                    }}
                  >
                    {service.no}
                  </span>
                </div>

                <div
                  style={{
                    position: 'relative',
                    padding: '22px 26px 28px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 9,
                  }}
                >
                  <span className="ghost-no">{service.no}</span>

                  <h3
                    style={{
                      position: 'relative',
                      fontFamily: 'var(--font-heading)',
                      fontWeight: 700,
                      fontSize: 20,
                      letterSpacing: '0.03em',
                      textTransform: 'uppercase',
                      margin: 0,
                      color: 'var(--text)',
                    }}
                  >
                    {service.title}
                  </h3>
                  <p
                    style={{
                      position: 'relative',
                      fontSize: 13.5,
                      lineHeight: 1.62,
                      color: 'var(--text-2)',
                      margin: 0,
                    }}
                  >
                    {service.body}
                  </p>
                  <span
                    style={{
                      position: 'relative',
                      marginTop: 4,
                      fontFamily: 'var(--font-heading)',
                      fontSize: 11,
                      fontWeight: 600,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--gold)',
                    }}
                  >
                    {service.meta}
                  </span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
