'use client';

import Image from 'next/image';
import Link from 'next/link';
import { NEWS, NEWS_LEAD } from '@/lib/landingData';

const TAG_COLORS: Record<string, string> = {
  Promo: '#f0b429',
  Schedule: '#63a4ff',
  Classes: '#5fd48a',
  Notice: '#c08cf5',
  Team: '#4fd1d9',
};

export default function AnnouncementsSection() {
  return (
    <section id="news" className="sec" style={{ background: 'var(--ground-2)' }}>
      <div className="wrap">
        {/* Header spans full width so the content below reads as one
            two-part composition instead of competing with a side rail. */}
        <div
          className="rv"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 20,
            marginBottom: 34,
          }}
        >
          <div>
            <span className="eyebrow">Stay in the know</span>
            <h2 className="h-sec">
              LATEST <em>NEWS</em>
            </h2>
          </div>
          <p className="lede" style={{ margin: 0, maxWidth: '34ch' }}>
            Promos, schedule changes and new classes — posted here first, and sent to members by
            SMS.
          </p>
        </div>

        <div className="news-layout">
          {/* ── Lead story ──
              Takes roughly 60% of the section's visual weight because it
              is the only item here that can actually make someone join.
              Everything was previously rendered at identical weight, so
              nothing led and the block read as filler. */}
          <article className="news-lead glow rv">
            <Image
              src={NEWS_LEAD.image}
              alt=""
              aria-hidden
              fill
              sizes="(max-width: 980px) 100vw, 55vw"
              style={{ objectFit: 'cover' }}
            />
            <div className="news-lead-scrim" />

            <div style={{ position: 'relative', zIndex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 16 }}>
                <span className="pill">
                  <span className="pill-dot" />
                  {NEWS_LEAD.tag}
                </span>
                <span
                  style={{
                    fontFamily: 'var(--font-heading)',
                    fontSize: 10.5,
                    fontWeight: 600,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    color: 'var(--text-3)',
                  }}
                >
                  {NEWS_LEAD.date}
                </span>
              </div>

              <h3
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontWeight: 800,
                  fontSize: 'clamp(24px, 2.9vw, 38px)',
                  lineHeight: 1.06,
                  letterSpacing: '-0.01em',
                  margin: 0,
                  color: '#fff',
                  maxWidth: '17ch',
                }}
              >
                {NEWS_LEAD.title}
              </h3>

              <p
                style={{
                  margin: '14px 0 0',
                  maxWidth: '46ch',
                  fontSize: 14.5,
                  lineHeight: 1.65,
                  color: 'var(--text-2)',
                }}
              >
                {NEWS_LEAD.body}
              </p>

              <Link
                id="news-lead-cta"
                href="/register"
                className="btn btn-gold"
                style={{
                  marginTop: 24,
                  padding: '14px 30px',
                  fontSize: 14,
                  letterSpacing: '0.1em',
                }}
              >
                {NEWS_LEAD.cta}
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
            </div>
          </article>

          {/* ── Everything else ──
              Colour-coded dots align into a single vertical rule, which
              is what makes a list of mixed-length labels scan as ordered
              rather than ragged. */}
          <div className="news-list rv">
            <div className="news-list-head">Also this month</div>

            {NEWS.map((item, index) => (
              <div key={index} className="news-row">
                <span
                  className="news-dot"
                  style={{ background: TAG_COLORS[item.tag] ?? 'var(--gold)' }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: 'var(--font-heading)',
                      fontSize: 10,
                      fontWeight: 600,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: TAG_COLORS[item.tag] ?? 'var(--gold)',
                      marginBottom: 5,
                    }}
                  >
                    {item.tag}
                  </div>
                  <div style={{ fontSize: 14, lineHeight: 1.5, color: 'var(--text)' }}>
                    {item.text}
                  </div>
                  <div style={{ marginTop: 6, fontSize: 11.5, color: 'var(--text-3)' }}>
                    {item.date}
                  </div>
                </div>
                <svg
                  className="news-arrow"
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden
                >
                  <path
                    d="M5 12h14M13 6l6 6-6 6"
                    stroke="currentColor"
                    strokeWidth="2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
