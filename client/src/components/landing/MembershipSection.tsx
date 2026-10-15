'use client';

import Link from 'next/link';
import type { LandingPlan } from '@/lib/landingData';

function Check() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M20 6L9 17l-5-5"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Prices come from the caller now, not from a constant in this file.
 *
 * `page.tsx` is a server component and fetches them from the live `/plans`
 * endpoint, so editing a price in the CRM changes what the marketing site
 * advertises. It used to render a hard-coded list, which meant a price change
 * updated every sale screen and left the front page quoting the old figure.
 */
export default function MembershipSection({ plans }: { plans: LandingPlan[] }) {
  return (
    <section
      id="membership"
      className="sec"
      style={{
        background:
          'linear-gradient(to bottom, var(--ground) 0%, var(--ground-2) 40%, var(--ground) 100%)',
        overflow: 'hidden',
      }}
    >
      {/* Spotlight aimed at the featured plan — the table is lit */}
      <div
        className="spot"
        style={{
          width: 760,
          height: 560,
          left: '50%',
          top: '20%',
          transform: 'translateX(-50%)',
          background: 'rgba(201,146,42,0.13)',
        }}
      />

      <div className="wrap" style={{ position: 'relative', zIndex: 1 }}>
        {/* One of only two centred headings on the page. It earns it —
            this is the moment of choice, so it gets a stage. */}
        <div
          className="rv"
          style={{
            textAlign: 'center',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginBottom: 46,
          }}
        >
          <span className="eyebrow">Choose your path</span>
          <h2 className="h-sec">
            MEMBERSHIP <em>PLANS</em>
          </h2>
          <p className="lede" style={{ textAlign: 'center' }}>
            No lock-in, no joining fee, no hidden charges. Pay at the counter or by GCash.
          </p>
        </div>

        <div className="plan-grid">
          {plans.map((plan) => (
            <div key={plan.id} className={`pcard glow rv${plan.featured ? ' featured' : ''}`}>
              {/* Badge row is always present so every card's price sits
                  on the same baseline, badge or not. */}
              <div style={{ minHeight: 24, display: 'flex', alignItems: 'center', gap: 8 }}>
                {plan.badge && (
                  <span
                    className="pill"
                    style={
                      plan.featured
                        ? {
                            background: 'linear-gradient(135deg, var(--gold-lit), var(--gold))',
                            borderColor: 'transparent',
                            color: '#14100a',
                            boxShadow: '0 4px 16px rgba(201,146,42,.4)',
                          }
                        : undefined
                    }
                  >
                    {plan.badge}
                  </span>
                )}
                {plan.saves && (
                  <span
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 10.5,
                      fontWeight: 700,
                      letterSpacing: '0.12em',
                      textTransform: 'uppercase',
                      color: '#6ee7a8',
                    }}
                  >
                    {plan.saves}
                  </span>
                )}
              </div>

              <div
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontSize: 11,
                  fontWeight: 600,
                  letterSpacing: '0.2em',
                  textTransform: 'uppercase',
                  color: 'var(--text-3)',
                }}
              >
                {plan.name} · {plan.tier}
              </div>

              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 800,
                    fontSize: plan.featured ? 56 : 46,
                    lineHeight: 1,
                    color: plan.featured ? 'var(--gold-lit)' : 'var(--text)',
                    letterSpacing: '-0.02em',
                  }}
                >
                  {plan.price}
                </span>
                <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>{plan.unit}</span>
              </div>

              {/* True per-month equivalent — the anchor that makes the
                  longer plans obviously the better deal. */}
              <div
                style={{
                  fontSize: 12.5,
                  color: plan.perMonth ? 'var(--gold)' : 'transparent',
                  fontVariantNumeric: 'tabular-nums',
                  minHeight: 18,
                }}
              >
                {plan.perMonth ?? '—'}
              </div>

              <hr className="hairline" style={{ margin: '6px 0 10px' }} />

              <ul
                style={{
                  listStyle: 'none',
                  margin: 0,
                  padding: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 9,
                  flex: 1,
                }}
              >
                {plan.perks.map((perk) => (
                  <li key={perk} className="perk">
                    <Check />
                    {perk}
                  </li>
                ))}
              </ul>

              <Link
                id={`plan-join-${plan.id}`}
                href="/register"
                className={`btn btn-block ${plan.featured ? 'btn-gold' : 'btn-ghost'}`}
                style={{ padding: 13, fontSize: 13, letterSpacing: '0.1em', marginTop: 18 }}
              >
                {plan.featured ? 'JOIN NOW' : 'CHOOSE'}
              </Link>
            </div>
          ))}
        </div>

        {/* Reassurance strip — kills the last objections and closes the
            gap under the cards that would otherwise be dead air. */}
        <div
          className="rv"
          style={{
            marginTop: 34,
            display: 'flex',
            flexWrap: 'wrap',
            justifyContent: 'center',
            gap: '12px 34px',
            padding: '18px 24px',
            border: '1px solid var(--line)',
            borderRadius: 12,
            background: 'rgba(255,255,255,.02)',
          }}
        >
          {[
            'Free first assessment',
            'Locker & shower included',
            'No joining fee',
            'Cancel anytime',
          ].map((item) => (
            <span
              key={item}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 9,
                fontSize: 13,
                color: 'var(--text-2)',
              }}
            >
              <span style={{ color: 'var(--gold)', display: 'inline-flex' }}>
                <Check />
              </span>
              {item}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
