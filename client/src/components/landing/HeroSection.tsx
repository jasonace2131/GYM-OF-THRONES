'use client';

import Image from 'next/image';
import Link from 'next/link';
import CountUp from './CountUp';
import { STATS, TICKER } from '@/lib/landingData';

export default function HeroSection() {
  return (
    <>
      <section
        style={{
          position: 'relative',
          minHeight: 'clamp(620px, 94vh, 940px)',
          display: 'flex',
          alignItems: 'flex-end',
          overflow: 'hidden',
        }}
      >
        {/* Backdrop */}
        <Image
          src="/assets/gym-wide.webp"
          alt=""
          aria-hidden
          fill
          preload
          sizes="100vw"
          style={{ objectFit: 'cover', animation: 'kenBurns 9s ease-out both' }}
        />

        {/* Layered scrims. The vertical one melts the photo into the
            page ground so there is no visible seam to the next section. */}
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(100deg, rgba(9,9,11,.94) 0%, rgba(9,9,11,.78) 42%, rgba(9,9,11,.28) 100%)',
          }}
        />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'linear-gradient(to bottom, rgba(9,9,11,.72) 0%, transparent 26%, transparent 52%, var(--ground) 99%)',
          }}
        />

        {/* Warm rim light from the right — makes the room feel lit */}
        <div
          className="spot"
          style={{
            width: 620,
            height: 620,
            right: '-8%',
            top: '12%',
            background: 'rgba(201,146,42,0.20)',
          }}
        />

        <div
          className="wrap"
          style={{
            position: 'relative',
            zIndex: 2,
            paddingBottom: 'clamp(96px, 12vh, 150px)',
            paddingTop: 130,
          }}
        >
          {/* Deliberately narrower than the container and hard left —
              the headline should run off toward the photo, not sit
              politely centred. */}
          <div style={{ maxWidth: 'min(100%, 880px)' }}>
            <div className="pill" style={{ animation: 'hFade .35s ease both .05s' }}>
              <span className="pill-dot" />
              Metro Manila · Now open
            </div>

            <h1
              style={{
                margin: '22px 0 0',
                lineHeight: 0.86,
                letterSpacing: '-0.015em',
                fontFamily: 'var(--font-heading)',
                fontWeight: 800,
                fontSize: 'clamp(58px, 11.2vw, 172px)',
                color: '#fff',
              }}
            >
              <span
                style={{
                  display: 'block',
                  animation: 'hLine .4s cubic-bezier(.2,.8,.2,1) both .06s',
                }}
              >
                GYM OF
              </span>
              <span
                style={{
                  display: 'block',
                  background:
                    'linear-gradient(175deg, #ffe7ad 4%, var(--gold-lit) 34%, var(--gold) 68%, #8f6318 100%)',
                  WebkitBackgroundClip: 'text',
                  backgroundClip: 'text',
                  color: 'transparent',
                  filter: 'drop-shadow(0 0 48px rgba(201,146,42,.4))',
                  animation: 'hLine .4s cubic-bezier(.2,.8,.2,1) both .16s',
                }}
              >
                THRONES
              </span>
            </h1>

            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 18,
                margin: '26px 0 0',
                animation: 'hUp .35s ease both .24s',
              }}
            >
              <span style={{ width: 54, height: 2, background: 'var(--gold)', flex: 'none' }} />
              <p
                style={{
                  margin: 0,
                  fontFamily: 'var(--font-heading)',
                  fontSize: 'clamp(13px, 1.5vw, 18px)',
                  fontWeight: 500,
                  letterSpacing: '0.3em',
                  textTransform: 'uppercase',
                  color: 'rgba(255,255,255,.72)',
                }}
              >
                Where champions train
              </p>
            </div>

            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 14,
                marginTop: 34,
                animation: 'hUp .35s ease both .3s',
              }}
            >
              <Link
                id="hero-join-btn"
                href="/register"
                className="btn btn-gold breathe"
                style={{ padding: '16px 38px', fontSize: 15, letterSpacing: '0.1em' }}
              >
                JOIN NOW
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </Link>
              <Link
                id="hero-login-btn"
                href="/login"
                className="btn btn-ghost"
                style={{ padding: '16px 32px', fontSize: 15, letterSpacing: '0.1em' }}
              >
                MEMBER LOGIN
              </Link>
            </div>

            {/* Objection-killers, right where the decision happens */}
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: '10px 24px',
                marginTop: 26,
                fontSize: 12.5,
                color: 'rgba(255,255,255,.5)',
                animation: 'hFade .35s ease both .38s',
              }}
            >
              {['No lock-in contract', 'Walk-ins from ₱90', 'Free first assessment'].map((item) => (
                <span key={item} style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path
                      d="M20 6L9 17l-5-5"
                      stroke="var(--gold)"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {item}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Scroll cue */}
        <div
          className="hide-mobile"
          aria-hidden
          style={{
            position: 'absolute',
            bottom: 118,
            left: '50%',
            zIndex: 2,
            width: 1,
            height: 44,
            background: 'linear-gradient(to bottom, transparent, var(--gold))',
            animation: 'scrollHint 2.4s ease-in-out infinite 2s',
          }}
        />
      </section>

      {/* ── Stats bar: straddles the hero seam on purpose. The overlap
          is what removes the horizontal dead band between sections. ── */}
      <div
        className="wrap"
        style={{ position: 'relative', zIndex: 3, marginTop: 'clamp(-64px, -5vw, -40px)' }}
      >
        <div
          className="glow"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            background: 'linear-gradient(140deg, var(--raised-2) 0%, var(--ground-2) 100%)',
            border: '1px solid var(--line-2)',
            borderRadius: 14,
            boxShadow: '0 26px 60px rgba(0,0,0,.62)',
            overflow: 'hidden',
          }}
        >
          {STATS.map((stat) => (
            <div key={stat.label} className="stat">
              <span className="stat-n">
                <CountUp value={stat.value} suffix={stat.suffix} />
              </span>
              <span className="stat-l">{stat.label}</span>
            </div>
          ))}
        </div>
      </div>

      {/* ── Ticker: a lit sign. Constant, unmissable motion. ── */}
      <div
        className="marquee"
        style={{
          marginTop: 'clamp(38px, 5vw, 60px)',
          background:
            'linear-gradient(90deg, var(--gold-deep), var(--gold) 22%, var(--gold-lit) 50%, var(--gold) 78%, var(--gold-deep))',
          padding: '13px 0',
        }}
      >
        <div className="marquee-track">
          {/* Rendered twice so the loop seam is invisible */}
          {[0, 1].map((copy) => (
            <div key={copy} style={{ display: 'flex' }} aria-hidden={copy === 1}>
              {TICKER.map((item) => (
                <span key={item} className="marquee-item">
                  {item}
                  <span data-dot />
                </span>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
