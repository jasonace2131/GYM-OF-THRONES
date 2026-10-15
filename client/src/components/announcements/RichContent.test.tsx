import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AnnouncementDoc } from '@got/shared';
import { NoticeCover, RichContent } from './RichContent';

/**
 * The renderer, rendered — to a string with react-dom/server, so the HTML a
 * member's browser would build is asserted directly, without a DOM testing
 * library. Every XSS case here is one the SERVER already refuses; these prove
 * the second lock holds on its own.
 */

const BASE = 'https://abcdefgh.supabase.co/storage/v1/object/public/announcements/';
const OURS = `${BASE}announcements/0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp`;

const doc = (...content: unknown[]): AnnouncementDoc =>
  ({ type: 'doc', content }) as AnnouncementDoc;
const para = (text: string, marks?: unknown[]) => ({
  type: 'paragraph',
  content: [{ type: 'text', text, ...(marks === undefined ? {} : { marks }) }],
});

const html = (value: AnnouncementDoc, fallback = 'FALLBACK'): string =>
  renderToStaticMarkup(<RichContent doc={value} fallback={fallback} imageBase={BASE} />);

describe('RichContent', () => {
  it('maps every allowed node to its element, with headings below the notice title', () => {
    const out = html(
      doc(
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Big' }] },
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Small' }] },
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'B', marks: [{ type: 'bold' }] },
            { type: 'text', text: 'I', marks: [{ type: 'italic' }] },
            { type: 'hardBreak' },
            { type: 'text', text: 'after' },
          ],
        },
        { type: 'bulletList', content: [{ type: 'listItem', content: [para('dot')] }] },
        {
          type: 'orderedList',
          attrs: { start: 3 },
          content: [{ type: 'listItem', content: [para('three')] }],
        },
        { type: 'blockquote', content: [para('quoted')] },
        { type: 'horizontalRule' },
      ),
    );

    expect(out).toMatch(/<h4[^>]*>Big<\/h4>/);
    expect(out).toMatch(/<h5[^>]*>Small<\/h5>/);
    expect(out).toMatch(/<strong[^>]*>B<\/strong>/);
    expect(out).toMatch(/<em[^>]*>I<\/em>/);
    expect(out).toContain('<br/>after');
    expect(out).toMatch(/<ul[^>]*><li[^>]*><p[^>]*>dot<\/p><\/li><\/ul>/);
    expect(out).toMatch(/<ol start="3"[^>]*>/);
    expect(out).toMatch(/<blockquote[^>]*><p[^>]*>quoted<\/p><\/blockquote>/);
    expect(out).toMatch(/<hr[^>]*\/>/);
  });

  it('opens an allowed link in a new tab with no opener', () => {
    const out = html(
      doc(para('site', [{ type: 'link', attrs: { href: 'https://gymofthrones.ph' } }])),
    );
    expect(out).toMatch(
      /<a href="https:\/\/gymofthrones\.ph" rel="noopener noreferrer nofollow" target="_blank"[^>]*>site<\/a>/,
    );
  });

  it.each([
    'javascript:alert(1)',
    'JAVASCRIPT:alert(1)',
    ' javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
  ])('renders a %p link as plain text', (href) => {
    const out = html(doc(para('click me', [{ type: 'link', attrs: { href } }])));
    expect(out).toContain('click me');
    expect(out).not.toContain('<a');
    expect(out.toLowerCase()).not.toContain('script:');
    expect(out).not.toContain('data:');
  });

  it('renders our image lazily with its size', () => {
    const out = html(
      doc(para('x'), {
        type: 'image',
        attrs: { src: OURS, alt: 'Rack', width: 1600, height: 900 },
      }),
    );
    expect(out).toContain(`src="${OURS}"`);
    expect(out).toContain('alt="Rack"');
    expect(out).toContain('width="1600"');
    expect(out).toContain('height="900"');
    expect(out).toContain('loading="lazy"');
  });

  it.each([
    'https://evil.example/pixel.png',
    'data:image/svg+xml,<svg onload=alert(1)>',
    OURS.replace('.webp', '.svg'),
    'javascript:alert(1)',
  ])('renders no image for %p', (src) => {
    const out = html(doc(para('x'), { type: 'image', attrs: { src } }));
    expect(out).not.toContain('<img');
  });

  it('escapes markup-looking text — it is text, never HTML', () => {
    const out = html(doc(para('<script>alert(1)</script><img src=x onerror=alert(1)>')));
    expect(out).not.toContain('<script>');
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;script&gt;');
  });

  it('never copies attributes it was not told about', () => {
    const out = html(
      doc({
        type: 'paragraph',
        attrs: { onclick: 'alert(1)', style: 'position:fixed', class: 'evil' },
        content: [
          {
            type: 'text',
            text: 'x',
            marks: [
              {
                type: 'link',
                attrs: { href: 'https://ok.example', onclick: 'alert(1)', style: 'x' },
              },
            ],
          },
        ],
      }),
    );
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('position:fixed');
    expect(out).not.toContain('evil');
  });

  it('renders nothing for an unknown node and keeps its siblings', () => {
    const out = html(
      doc(
        para('before'),
        { type: 'iframe', attrs: { src: 'https://evil.example' } },
        para('after'),
      ),
    );
    expect(out).not.toContain('iframe');
    expect(out).not.toContain('evil');
    expect(out).toContain('before');
    expect(out).toContain('after');
  });

  it('renders the text of an unknown mark without its styling', () => {
    const out = html(
      doc(para('shout', [{ type: 'textStyle', attrs: { style: 'font-size:99px' } }])),
    );
    expect(out).toContain('shout');
    expect(out).not.toContain('font-size');
  });

  it('falls back to the plain text when the document cannot be walked', () => {
    const broken = { type: 'doc', content: 'not a list' } as unknown as AnnouncementDoc;
    const out = html(broken, 'Plain body');
    expect(out).toContain('Plain body');
  });

  it('gives an empty paragraph a line of height, as the editor showed it', () => {
    expect(html(doc(para('a'), { type: 'paragraph' }, para('b')))).toMatch(/<p[^>]*><br\/><\/p>/);
  });
});

describe('NoticeCover', () => {
  it('renders our cover image with reserved space', () => {
    const out = renderToStaticMarkup(<NoticeCover url={OURS} imageBase={BASE} />);
    expect(out).toContain(`src="${OURS}"`);
    expect(out).toContain('loading="lazy"');
    expect(out).toMatch(/width="\d+"/);
    expect(out).toMatch(/height="\d+"/);
  });

  it('renders nothing for a cover from elsewhere, or none at all', () => {
    expect(
      renderToStaticMarkup(<NoticeCover url="https://evil.example/x.jpg" imageBase={BASE} />),
    ).toBe('');
    expect(renderToStaticMarkup(<NoticeCover url={null} imageBase={BASE} />)).toBe('');
  });
});
