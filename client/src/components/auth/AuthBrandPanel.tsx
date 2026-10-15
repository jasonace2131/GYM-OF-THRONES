'use client';

import Image from 'next/image';

interface AuthBrandPanelProps {
  image: string;
  imageAlt: string;
  backLabel: string;
  onBack: () => void;
  /** Rendered one line per entry, tightly stacked. */
  headline: readonly string[];
  kicker: string;
  blurb: string;
}

/**
 * The lit half of the auth split-screen.
 *
 * Shared by sign-in and register so the two screens stay identical
 * except for their copy — the panel was duplicated verbatim before.
 */
export default function AuthBrandPanel({
  image,
  imageAlt,
  backLabel,
  onBack,
  headline,
  kicker,
  blurb,
}: AuthBrandPanelProps) {
  return (
    <div className="auth-brand">
      <Image
        src={image}
        alt={imageAlt}
        fill
        priority
        sizes="(max-width: 940px) 100vw, 52vw"
        className="auth-brand-photo"
      />
      <div className="auth-brand-scrim" />
      <div
        className="spot"
        style={{
          width: 460,
          height: 460,
          left: '-14%',
          bottom: '-6%',
          background: 'rgba(201,146,42,0.24)',
        }}
      />
      {/* Gold seam against the form panel */}
      <div className="auth-brand-seam" />

      <div
        style={{
          position: 'relative',
          zIndex: 1,
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          gap: 40,
          padding: 'clamp(28px, 3.4vw, 46px)',
        }}
      >
        <button
          className="btn btn-ghost"
          style={{
            alignSelf: 'flex-start',
            fontSize: 12.5,
            letterSpacing: '0.1em',
            padding: '9px 18px',
          }}
          onClick={onBack}
        >
          {backLabel}
        </button>

        <div>
          <Image
            src="/assets/logo.webp"
            alt="Gym of Thrones"
            width={96}
            height={96}
            style={{
              borderRadius: '50%',
              objectFit: 'cover',
              marginBottom: 26,
              border: '2px solid var(--gold)',
              boxShadow: '0 0 44px rgba(201,146,42,.45)',
            }}
          />

          <div
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 800,
              fontSize: 'clamp(38px, 4.6vw, 66px)',
              lineHeight: 0.92,
              letterSpacing: '-0.01em',
              color: '#fff',
            }}
          >
            {headline.map((line, index) => (
              <span
                key={line}
                style={{
                  display: 'block',
                  color: index === headline.length - 1 ? 'var(--gold-lit)' : undefined,
                }}
              >
                {line}
              </span>
            ))}
          </div>

          <div style={{ width: 52, height: 3, background: 'var(--gold)', margin: '20px 0 15px' }} />

          <div
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.22em',
              textTransform: 'uppercase',
              color: 'var(--gold)',
            }}
          >
            {kicker}
          </div>

          <p
            style={{
              margin: '14px 0 0',
              fontSize: 14,
              lineHeight: 1.65,
              color: 'var(--text-2)',
              maxWidth: '34ch',
            }}
          >
            {blurb}
          </p>
        </div>
      </div>
    </div>
  );
}
