import {
  ANNOUNCEMENT_CONTENT_MAX,
  ANNOUNCEMENT_DOC_MAX_BYTES,
  RICH_MAX_DEPTH,
  announcementDocToPlainText,
  announcementImageBaseUrl,
  announcementImageKey,
  collectAnnouncementImageUrls,
  isAllowedLinkHref,
  isAnnouncementImageUrl,
  sanitizeAnnouncementDoc,
  type AnnouncementDoc,
} from './rich-content';

const SUPABASE_URL = 'https://abcdefgh.supabase.co';
const BASE = 'https://abcdefgh.supabase.co/storage/v1/object/public/announcements/';
const KEY = 'announcements/0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp';
const IMAGE = `${BASE}${KEY}`;
const RULES = { imageBaseUrl: BASE };

/** A paragraph of plain text — the smallest valid block. */
const para = (text: string): Record<string, unknown> => ({
  type: 'paragraph',
  content: [{ type: 'text', text }],
});

const doc = (...content: unknown[]): Record<string, unknown> => ({ type: 'doc', content });

/** A document that is valid in every way except the one node under test. */
const withBlock = (block: unknown): Record<string, unknown> => doc(para('Hello members'), block);

const linked = (href: unknown): Record<string, unknown> =>
  doc({
    type: 'paragraph',
    content: [{ type: 'text', text: 'click me', marks: [{ type: 'link', attrs: { href } }] }],
  });

const imaged = (src: unknown): Record<string, unknown> =>
  withBlock({ type: 'image', attrs: { src, alt: 'Floor plan' } });

function accepted(input: unknown): { doc: AnnouncementDoc; text: string } {
  const result = sanitizeAnnouncementDoc(input, RULES);
  if (!result.ok) throw new Error(`expected acceptance, got: ${result.reason}`);
  return result;
}

function rejected(input: unknown): string {
  const result = sanitizeAnnouncementDoc(input, RULES);
  if (result.ok) throw new Error('expected rejection, but the document was accepted');
  return result.reason;
}

// ─────────────────────────────────────────────────────────────────────────────

describe('isAllowedLinkHref', () => {
  it.each([
    'https://gymofthrones.ph',
    'http://example.com/path?q=1#top',
    'HTTPS://EXAMPLE.COM',
    'mailto:frontdesk@gymofthrones.ph',
    'MAILTO:frontdesk@gymofthrones.ph?subject=Hours',
  ])('accepts %s', (href) => {
    expect(isAllowedLinkHref(href)).toBe(true);
  });

  it.each([
    ['javascript:', 'javascript:alert(1)'],
    ['mixed-case javascript:', 'JaVaScRiPt:alert(1)'],
    ['a leading space before javascript:', ' javascript:alert(1)'],
    ['a tab inside the scheme', 'java\tscript:alert(1)'],
    ['a newline inside the scheme', 'java\nscript:alert(1)'],
    ['a NUL before the scheme', '\u0000javascript:alert(1)'],
    ['an entity-looking scheme', 'javascript&#58;alert(1)'],
    ['data:', 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=='],
    ['vbscript:', 'vbscript:msgbox(1)'],
    ['file:', 'file:///etc/passwd'],
    ['protocol-relative', '//evil.example/x'],
    ['relative', '/admin'],
    ['a bare domain', 'example.com'],
    ['a scheme with no host', 'https://'],
    ['a triple slash', 'https:///evil.example'],
    ['an empty mailto', 'mailto:'],
    ['whitespace inside', 'https://exa mple.com'],
    ['a trailing space', 'https://example.com '],
    ['a backslash', 'https:\\\\evil.example'],
    ['an empty string', ''],
    ['a non-string', 42],
    ['an over-long URL', `https://example.com/${'a'.repeat(2100)}`],
  ])('refuses %s', (_label, href) => {
    expect(isAllowedLinkHref(href)).toBe(false);
  });
});

describe('announcementImageBaseUrl', () => {
  it('is the public URL of the announcements bucket', () => {
    expect(announcementImageBaseUrl(SUPABASE_URL)).toBe(BASE);
  });

  it('ignores trailing slashes on SUPABASE_URL', () => {
    expect(announcementImageBaseUrl(`${SUPABASE_URL}//`)).toBe(BASE);
  });
});

describe('isAnnouncementImageUrl', () => {
  it('accepts an object this server minted, in each allowed format', () => {
    expect(isAnnouncementImageUrl(IMAGE, BASE)).toBe(true);
    expect(isAnnouncementImageUrl(IMAGE.replace('.webp', '.jpg'), BASE)).toBe(true);
    expect(isAnnouncementImageUrl(IMAGE.replace('.webp', '.png'), BASE)).toBe(true);
  });

  it.each([
    ['another host', `https://evil.example/storage/v1/object/public/announcements/${KEY}`],
    ['the http twin of the bucket', IMAGE.replace('https://', 'http://')],
    ['a data: URL', 'data:image/png;base64,iVBORw0KGgo='],
    ['an SVG data: URL', 'data:image/svg+xml,<svg onload="alert(1)"/>'],
    ['an SVG object', IMAGE.replace('.webp', '.svg')],
    ['an HTML object', IMAGE.replace('.webp', '.html')],
    ['another bucket', IMAGE.replace('/public/announcements/', '/public/gcash-proofs/')],
    ['a traversal out of the bucket', `${BASE}../gcash-proofs/${KEY}`],
    ['an encoded traversal', `${BASE}%2e%2e/gcash-proofs/${KEY}`],
    ['a query string', `${IMAGE}?download=1`],
    ['a fragment', `${IMAGE}#x`],
    ['a name this server never mints', `${BASE}announcements/logo.webp`],
    ['a key outside the prefix', `${BASE}0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp`],
    ['the base alone', BASE],
    ['a non-string', { src: IMAGE }],
  ])('refuses %s', (_label, url) => {
    expect(isAnnouncementImageUrl(url, BASE)).toBe(false);
  });

  it('refuses everything when the bucket base is not https', () => {
    const httpBase = announcementImageBaseUrl('http://127.0.0.1:54321');
    expect(isAnnouncementImageUrl(`${httpBase}${KEY}`, httpBase)).toBe(false);
  });
});

describe('announcementImageKey', () => {
  it('is the object key inside the bucket', () => {
    expect(announcementImageKey(IMAGE, BASE)).toBe(KEY);
  });

  it('is null for anything that is not one of ours', () => {
    expect(announcementImageKey('https://evil.example/x.webp', BASE)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('sanitizeAnnouncementDoc — what it accepts', () => {
  it('accepts every allowed node and mark, and returns the canonical document', () => {
    const input = doc(
      { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Holiday hours' }] },
      {
        type: 'paragraph',
        content: [
          { type: 'text', text: 'We open ' },
          { type: 'text', text: 'late', marks: [{ type: 'bold' }, { type: 'italic' }] },
          { type: 'hardBreak' },
          {
            type: 'text',
            text: 'details',
            marks: [{ type: 'link', attrs: { href: 'https://gymofthrones.ph/hours' } }],
          },
        ],
      },
      { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Classes' }] },
      {
        type: 'bulletList',
        content: [{ type: 'listItem', content: [para('Yoga moves to 9am')] }],
      },
      {
        type: 'orderedList',
        attrs: { start: 3 },
        content: [{ type: 'listItem', content: [para('Bring a towel')] }],
      },
      { type: 'blockquote', content: [para('See you there')] },
      { type: 'horizontalRule' },
      { type: 'image', attrs: { src: IMAGE, alt: 'The new rack', width: 1600, height: 900 } },
    );

    const { doc: out } = accepted(input);

    expect(out).toEqual(input);
  });

  it('keeps an empty paragraph — the editor writes one for a blank line', () => {
    const { doc: out } = accepted(doc(para('One'), { type: 'paragraph' }, para('Two')));
    expect(out.content[1]).toEqual({ type: 'paragraph' });
  });

  it('accepts lists nested inside list items', () => {
    const nested = {
      type: 'bulletList',
      content: [
        {
          type: 'listItem',
          content: [
            para('Outer'),
            { type: 'bulletList', content: [{ type: 'listItem', content: [para('Inner')] }] },
          ],
        },
      ],
    };
    expect(accepted(doc(nested)).doc.content[0]).toEqual(nested);
  });

  it('drops every attribute it does not know, so none can reach the renderer', () => {
    const input = doc(
      {
        type: 'paragraph',
        attrs: { style: 'position:fixed', onclick: 'alert(1)', class: 'x', textAlign: 'center' },
        content: [
          {
            type: 'text',
            text: 'hi',
            attrs: { onmouseover: 'alert(1)' },
            marks: [
              {
                type: 'link',
                attrs: {
                  href: 'https://example.com',
                  target: '_self',
                  rel: 'opener',
                  class: 'evil',
                  onclick: 'alert(1)',
                },
              },
            ],
          },
        ],
      },
      {
        type: 'heading',
        attrs: { level: 2, id: 'x', style: 'color:red' },
        content: [{ type: 'text', text: 'T' }],
      },
      {
        type: 'orderedList',
        attrs: { start: 1, type: 'a', onload: 'x' },
        content: [{ type: 'listItem', attrs: { hidden: true }, content: [para('a')] }],
      },
      {
        type: 'image',
        attrs: { src: IMAGE, alt: 'a', title: 'x', onerror: 'alert(1)', srcset: 'evil 1x' },
      },
    );

    const { doc: out } = accepted(input);

    expect(out).toEqual(
      doc(
        {
          type: 'paragraph',
          content: [
            {
              type: 'text',
              text: 'hi',
              marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
            },
          ],
        },
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'T' }] },
        {
          type: 'orderedList',
          attrs: { start: 1 },
          content: [{ type: 'listItem', content: [para('a')] }],
        },
        { type: 'image', attrs: { src: IMAGE, alt: 'a' } },
      ),
    );
  });

  it('drops keys a ProseMirror node never has', () => {
    const { doc: out } = accepted({
      type: 'doc',
      content: [{ ...para('x'), html: '<script>alert(1)</script>', __html: 'x' }],
      dangerouslySetInnerHTML: { __html: '<img onerror=alert(1)>' },
    });
    expect(out).toEqual(doc(para('x')));
  });

  it('keeps markup-looking text as text — the renderer escapes it', () => {
    const { doc: out, text } = accepted(doc(para('<script>alert(1)</script>')));
    expect(out).toEqual(doc(para('<script>alert(1)</script>')));
    expect(text).toBe('<script>alert(1)</script>');
  });

  it('collapses a repeated mark to one', () => {
    const { doc: out } = accepted(
      doc({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }, { type: 'bold' }] }],
      }),
    );
    expect(out).toEqual(
      doc({ type: 'paragraph', content: [{ type: 'text', text: 'x', marks: [{ type: 'bold' }] }] }),
    );
  });

  it('drops image dimensions that are not sensible whole numbers, and a non-string alt', () => {
    const { doc: out } = accepted(
      withBlock({ type: 'image', attrs: { src: IMAGE, alt: 7, width: -3, height: '900' } }),
    );
    expect(out.content[1]).toEqual({ type: 'image', attrs: { src: IMAGE } });
  });

  it('returns the derived plain text alongside the document', () => {
    expect(accepted(doc(para('One'), para('Two'))).text).toBe('One\n\nTwo');
  });
});

describe('sanitizeAnnouncementDoc — what it refuses (XSS and friends)', () => {
  it.each([
    ['javascript:', 'javascript:alert(document.cookie)'],
    ['mixed-case javascript:', 'JAVASCRIPT:alert(1)'],
    ['whitespace-prefixed javascript:', '\u0001 javascript:alert(1)'],
    ['a tab-split javascript:', 'jav\tascript:alert(1)'],
    ['data:', 'data:text/html,<script>alert(1)</script>'],
    ['vbscript:', 'vbscript:alert(1)'],
    ['a relative path', '/admin/members'],
    ['a missing href', undefined],
    ['a non-string href', { toString: 'javascript:alert(1)' }],
  ])('refuses a link with %s', (_label, href) => {
    expect(rejected(linked(href))).toMatch(/link/i);
  });

  it.each([
    ['a data: SVG', 'data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+'],
    ['a data: PNG', 'data:image/png;base64,iVBORw0KGgo='],
    ['an SVG in our own bucket', IMAGE.replace('.webp', '.svg')],
    ['a hotlinked image', 'https://evil.example/cat.png'],
    ['a javascript: src', 'javascript:alert(1)'],
    ['another bucket', IMAGE.replace('/public/announcements/', '/public/gcash-proofs/')],
    ['a missing src', undefined],
  ])('refuses an image with %s', (_label, src) => {
    expect(rejected(imaged(src))).toMatch(/image/i);
  });

  it.each(['script', 'iframe', 'codeBlock', 'table', 'video', 'mention', 'htmlBlock', ''])(
    'refuses the unknown node type %p',
    (type) => {
      expect(rejected(withBlock({ type, content: [{ type: 'text', text: 'x' }] }))).toMatch(
        /not allowed|unsupported/i,
      );
    },
  );

  it.each(['code', 'strike', 'underline', 'textStyle', 'highlight', 'subscript'])(
    'refuses the unknown mark %p',
    (type) => {
      const input = doc({
        type: 'paragraph',
        content: [{ type: 'text', text: 'x', marks: [{ type, attrs: { style: 'color:red' } }] }],
      });
      expect(rejected(input)).toMatch(/not allowed|unsupported/i);
    },
  );

  it.each([1, 4, 6, '2', null])('refuses a heading of level %p', (level) => {
    expect(
      rejected(
        withBlock({ type: 'heading', attrs: { level }, content: [{ type: 'text', text: 'x' }] }),
      ),
    ).toMatch(/heading/i);
  });

  it.each([
    ['a text node at block level', withBlock({ type: 'text', text: 'loose' })],
    ['a paragraph inside a paragraph', withBlock({ type: 'paragraph', content: [para('x')] })],
    ['a list item outside a list', withBlock({ type: 'listItem', content: [para('x')] })],
    ['a paragraph directly inside a list', withBlock({ type: 'bulletList', content: [para('x')] })],
    [
      'an image inside a paragraph',
      withBlock({ type: 'paragraph', content: [{ type: 'image', attrs: { src: IMAGE } }] }),
    ],
    ['an empty list', withBlock({ type: 'bulletList', content: [] })],
    [
      'an empty list item',
      withBlock({ type: 'bulletList', content: [{ type: 'listItem', content: [] }] }),
    ],
    ['an empty blockquote', withBlock({ type: 'blockquote' })],
  ])('refuses %s', (_label, input) => {
    expect(rejected(input)).toBeTruthy();
  });

  it.each([
    ['null', null],
    ['an array', [para('x')]],
    ['a string', '<p>hello</p>'],
    ['a number', 7],
    ['a paragraph as the root', para('x')],
    ['a doc with no content array', { type: 'doc', content: 'x' }],
    ['a node that is not an object', doc('just a string')],
    [
      'a content list that is not an array',
      withBlock({ type: 'paragraph', content: { type: 'text', text: 'x' } }),
    ],
  ])('refuses %s', (_label, input) => {
    expect(rejected(input)).toBeTruthy();
  });

  it('refuses an empty text node, which ProseMirror itself cannot load', () => {
    expect(
      rejected(doc({ type: 'paragraph', content: [{ type: 'text', text: '' }] })),
    ).toBeTruthy();
  });

  it('refuses a text node whose text is not a string', () => {
    expect(
      rejected(doc({ type: 'paragraph', content: [{ type: 'text', text: 42 }] })),
    ).toBeTruthy();
  });

  it('refuses a document with no text at all — previews and the bell need some', () => {
    expect(rejected(doc({ type: 'image', attrs: { src: IMAGE } }))).toMatch(/text/i);
    expect(rejected(doc({ type: 'paragraph' }))).toMatch(/text/i);
    expect(rejected(doc(para('   ')))).toMatch(/text/i);
  });

  it(`refuses derived text longer than ${ANNOUNCEMENT_CONTENT_MAX} characters`, () => {
    expect(accepted(doc(para('x'.repeat(ANNOUNCEMENT_CONTENT_MAX)))).text).toHaveLength(
      ANNOUNCEMENT_CONTENT_MAX,
    );
    expect(rejected(doc(para('x'.repeat(ANNOUNCEMENT_CONTENT_MAX + 1))))).toMatch(/4,?000/);
  });

  it('counts characters the way Postgres does, so an emoji is one', () => {
    const emoji = '💪'.repeat(ANNOUNCEMENT_CONTENT_MAX);
    expect(accepted(doc(para(emoji))).text).toBe(emoji);
  });

  it(`refuses a document over ${ANNOUNCEMENT_DOC_MAX_BYTES / 1024} KB once serialised`, () => {
    // Bold on every other word keeps the derived text under 4,000 characters
    // while the JSON grows well past the byte cap.
    const content = Array.from({ length: 1500 }, (_, i) => ({
      type: 'text',
      text: 'x',
      marks: [{ type: 'link', attrs: { href: `https://example.com/${'p'.repeat(40)}/${i}` } }],
    }));
    expect(rejected(doc({ type: 'paragraph', content }))).toMatch(/too large|KB/i);
  });

  describe('depth bombs', () => {
    /** Built with a loop, so the TEST cannot overflow the stack building it. */
    function nestedQuotes(depth: number): Record<string, unknown> {
      let node: Record<string, unknown> = para('deep');
      for (let i = 0; i < depth; i += 1) node = { type: 'blockquote', content: [node] };
      return doc(node);
    }

    function nestedLists(depth: number): Record<string, unknown> {
      let node: Record<string, unknown> = para('deep');
      for (let i = 0; i < depth; i += 1) {
        node = { type: 'bulletList', content: [{ type: 'listItem', content: [node] }] };
      }
      return doc(node);
    }

    it('accepts nesting within the limit', () => {
      expect(accepted(nestedQuotes(RICH_MAX_DEPTH - 3)).text).toBe('deep');
    });

    it('refuses nesting past the limit', () => {
      expect(rejected(nestedQuotes(RICH_MAX_DEPTH + 1))).toMatch(/nested/i);
      expect(rejected(nestedLists(RICH_MAX_DEPTH))).toMatch(/nested/i);
    });

    it('refuses a 100,000-deep bomb without overflowing the stack', () => {
      expect(() => sanitizeAnnouncementDoc(nestedQuotes(100_000), RULES)).not.toThrow();
      expect(rejected(nestedQuotes(100_000))).toMatch(/nested/i);
    });

    it('refuses a bomb of bare nested arrays', () => {
      let bomb: unknown[] = [];
      for (let i = 0; i < 100_000; i += 1) bomb = [bomb];
      expect(rejected({ type: 'doc', content: bomb })).toBeTruthy();
    });

    it('refuses a wide bomb — too many nodes — without walking all of them', () => {
      const content = Array.from({ length: 20_000 }, () => ({ type: 'hardBreak' }));
      expect(rejected(doc({ type: 'paragraph', content }))).toMatch(/too large|too many/i);
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('announcementDocToPlainText', () => {
  const text = (...content: unknown[]): string =>
    announcementDocToPlainText(doc(...content) as unknown as AnnouncementDoc);

  it('separates blocks with a blank line and trims the result', () => {
    expect(text(para('  Hello'), para('World  '))).toBe('Hello\n\nWorld');
  });

  it('reads a heading as its text', () => {
    expect(
      text(
        { type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Hours' }] },
        para('x'),
      ),
    ).toBe('Hours\n\nx');
  });

  it('turns a hard break into a newline and joins marked runs', () => {
    expect(
      text({
        type: 'paragraph',
        content: [
          { type: 'text', text: 'Open ', marks: [{ type: 'bold' }] },
          { type: 'text', text: 'late' },
          { type: 'hardBreak' },
          { type: 'text', text: 'Friday' },
        ],
      }),
    ).toBe('Open late\nFriday');
  });

  it('prefixes bullets and numbers, honouring an ordered list’s start', () => {
    expect(
      text(
        {
          type: 'bulletList',
          content: [
            { type: 'listItem', content: [para('Towel')] },
            { type: 'listItem', content: [para('Water')] },
          ],
        },
        {
          type: 'orderedList',
          attrs: { start: 4 },
          content: [
            { type: 'listItem', content: [para('Warm up')] },
            { type: 'listItem', content: [para('Lift')] },
          ],
        },
      ),
    ).toBe('• Towel\n• Water\n\n4. Warm up\n5. Lift');
  });

  it('leaves images and rules out of the text', () => {
    expect(
      text(
        para('Before'),
        { type: 'image', attrs: { src: IMAGE } },
        { type: 'horizontalRule' },
        para('After'),
      ),
    ).toBe('Before\n\nAfter');
  });

  it('reads a blockquote as its paragraphs', () => {
    expect(text({ type: 'blockquote', content: [para('Quoted'), para('Twice')] })).toBe(
      'Quoted\n\nTwice',
    );
  });

  it('skips empty paragraphs rather than stacking blank lines', () => {
    expect(text(para('One'), { type: 'paragraph' }, para('Two'))).toBe('One\n\nTwo');
  });
});

describe('collectAnnouncementImageUrls', () => {
  it('finds every image src, however deep', () => {
    const other = IMAGE.replace('0b6a3c4e', '1c7b4d5f');
    const input = doc(
      { type: 'image', attrs: { src: IMAGE } },
      {
        type: 'bulletList',
        content: [
          { type: 'listItem', content: [para('x'), { type: 'image', attrs: { src: other } }] },
        ],
      },
    );
    expect(collectAnnouncementImageUrls(input).sort()).toEqual([IMAGE, other].sort());
  });

  it('tolerates stored JSON that is malformed or absent', () => {
    expect(collectAnnouncementImageUrls(null)).toEqual([]);
    expect(collectAnnouncementImageUrls('x')).toEqual([]);
    expect(collectAnnouncementImageUrls({ type: 'doc', content: [{ type: 'image' }] })).toEqual([]);
  });

  it('stops at the depth limit rather than recursing forever', () => {
    let node: Record<string, unknown> = { type: 'image', attrs: { src: IMAGE } };
    for (let i = 0; i < 100_000; i += 1) node = { type: 'blockquote', content: [node] };
    expect(() => collectAnnouncementImageUrls(doc(node))).not.toThrow();
  });
});
