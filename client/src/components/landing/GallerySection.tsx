'use client';

import Image from 'next/image';
import { GALLERY } from '@/lib/landingData';

const SPAN_CLASS: Record<string, string> = {
  tall: 'm-tall',
  wide: 'm-wide',
  unit: '',
};

export default function GallerySection() {
  return (
    <section id="floor" className="sec" style={{ background: 'var(--ground)', overflow: 'hidden' }}>
      {/* Heading stays hard left and the mosaic below runs the full
          width of the viewport — the one place the page deliberately
          breaks its own container. */}
      <div className="wrap" style={{ marginBottom: 28 }}>
        <div
          className="rv"
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'flex-end',
            justifyContent: 'space-between',
            gap: 20,
          }}
        >
          <div>
            <span className="eyebrow">Our facility</span>
            <h2 className="h-sec">
              THE <em>FLOOR</em>
            </h2>
          </div>
          <p className="lede" style={{ margin: 0, maxWidth: '38ch' }}>
            Two levels, purpose-built zones, and equipment that is actually free when you want it.
          </p>
        </div>
      </div>

      <div className="bleed rv">
        <div className="mosaic">
          {GALLERY.map((shot, index) => (
            <figure key={shot.src} className={SPAN_CLASS[shot.span] ?? ''}>
              <Image
                src={shot.src}
                alt={shot.alt}
                fill
                sizes="(max-width: 900px) 50vw, 30vw"
                className="gcard-img"
                style={{ objectFit: 'cover' }}
              />
              {/* Bottom scrim + caption, revealed on hover */}
              <figcaption>
                <span>{shot.alt}</span>
              </figcaption>
              {/* Was "Open now · 5AM–11PM" — two claims the page could not
                  support: a hardcoded closing hour that disagreed with the
                  door, and "now", which a server-rendered page cannot know.
                  The real hours are in the contact section and the footer,
                  read live from the same table the gate uses. */}
              {index === 0 && (
                <span className="mosaic-badge">
                  <span className="pill-dot" />
                  The floor
                </span>
              )}
            </figure>
          ))}
        </div>
      </div>
    </section>
  );
}
