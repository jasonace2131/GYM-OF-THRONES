import { describe, expect, it } from 'vitest';
import { announcementDocToPlainText } from '@got/shared';
import {
  derivedLength,
  headingTag,
  imageAttributes,
  linkAttributes,
  nextToolbarIndex,
  normalizeLinkInput,
  plainTextToDoc,
} from './rich';

const BASE = 'https://abcdefgh.supabase.co/storage/v1/object/public/announcements/';
const IMAGE = `${BASE}announcements/0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp`;

describe('linkAttributes', () => {
  it('opens an allowed link in a new tab, with no opener and no referrer', () => {
    expect(linkAttributes('https://gymofthrones.ph')).toEqual({
      href: 'https://gymofthrones.ph',
      rel: 'noopener noreferrer nofollow',
      target: '_blank',
    });
  });

  it('keeps a mailto: link', () => {
    expect(linkAttributes('mailto:desk@gymofthrones.ph')?.href).toBe('mailto:desk@gymofthrones.ph');
  });

  it.each([
    'javascript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'JAVASCRIPT:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:x',
    '//evil.example',
    '/admin',
    '',
    undefined,
    42,
  ])('renders no link at all for %p — the text still shows, unlinked', (href) => {
    expect(linkAttributes(href)).toBeNull();
  });
});

describe('imageAttributes', () => {
  it('passes an image from our bucket with its size, lazily', () => {
    expect(imageAttributes({ src: IMAGE, alt: 'Rack', width: 1600, height: 900 }, BASE)).toEqual({
      src: IMAGE,
      alt: 'Rack',
      width: 1600,
      height: 900,
    });
  });

  it('defaults alt to empty (decorative) and omits unknown sizes', () => {
    expect(imageAttributes({ src: IMAGE }, BASE)).toEqual({ src: IMAGE, alt: '' });
  });

  it('drops every other attribute', () => {
    const out = imageAttributes(
      { src: IMAGE, onerror: 'alert(1)', srcset: 'evil 1x', style: 'x' },
      BASE,
    );
    expect(Object.keys(out ?? {}).sort()).toEqual(['alt', 'src']);
  });

  it.each([
    ['a hotlinked image', 'https://evil.example/cat.png'],
    ['a data: SVG', 'data:image/svg+xml,<svg onload=alert(1)>'],
    ['an SVG in the bucket', IMAGE.replace('.webp', '.svg')],
    ['a javascript: src', 'javascript:alert(1)'],
  ])('renders nothing for %s', (_label, src) => {
    expect(imageAttributes({ src }, BASE)).toBeNull();
  });

  it('renders nothing when the bucket base is not known', () => {
    expect(imageAttributes({ src: IMAGE }, '/storage/v1/object/public/announcements/')).toBeNull();
  });

  it('renders nothing for attrs that are not an object', () => {
    expect(imageAttributes(null, BASE)).toBeNull();
    expect(imageAttributes('x', BASE)).toBeNull();
  });
});

describe('headingTag', () => {
  it('shifts the document’s H2 and H3 below the notice’s own title', () => {
    expect(headingTag(2, 4)).toBe('h4');
    expect(headingTag(3, 4)).toBe('h5');
    expect(headingTag(2, 3)).toBe('h3');
  });

  it('never goes past h6, and treats a bad level as the top one', () => {
    expect(headingTag(3, 6)).toBe('h6');
    expect(headingTag('3', 4)).toBe('h4');
    expect(headingTag(undefined, 4)).toBe('h4');
  });
});

describe('plainTextToDoc', () => {
  it('turns blank-line paragraphs into paragraphs and single newlines into hard breaks', () => {
    expect(plainTextToDoc('Closed Friday.\nOpen Saturday.\n\nSee you!')).toEqual({
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [
            { type: 'text', text: 'Closed Friday.' },
            { type: 'hardBreak' },
            { type: 'text', text: 'Open Saturday.' },
          ],
        },
        { type: 'paragraph', content: [{ type: 'text', text: 'See you!' }] },
      ],
    });
  });

  it('round-trips through the derived plain text the server stores', () => {
    const text = 'Line one\nLine two\n\nSecond paragraph';
    expect(announcementDocToPlainText(plainTextToDoc(text))).toBe(text);
  });

  it('normalises Windows newlines and collapses runs of blank lines', () => {
    expect(announcementDocToPlainText(plainTextToDoc('a\r\n\r\n\r\n\r\nb'))).toBe('a\n\nb');
  });

  it('gives an empty document one empty paragraph, which the editor can hold', () => {
    expect(plainTextToDoc('')).toEqual({ type: 'doc', content: [{ type: 'paragraph' }] });
  });
});

describe('normalizeLinkInput', () => {
  it.each([
    ['https://gymofthrones.ph', 'https://gymofthrones.ph'],
    ['  https://gymofthrones.ph/hours  ', 'https://gymofthrones.ph/hours'],
    ['gymofthrones.ph', 'https://gymofthrones.ph'],
    ['www.gymofthrones.ph/classes', 'https://www.gymofthrones.ph/classes'],
    ['desk@gymofthrones.ph', 'mailto:desk@gymofthrones.ph'],
    ['mailto:desk@gymofthrones.ph', 'mailto:desk@gymofthrones.ph'],
    ['HTTP://EXAMPLE.COM', 'HTTP://EXAMPLE.COM'],
  ])('reads %p as %p', (raw, href) => {
    expect(normalizeLinkInput(raw)).toBe(href);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,x',
    'ftp://example.com',
    'file:///etc/passwd',
    '',
    '   ',
    'not a link',
    '/relative',
  ])('refuses %p', (raw) => {
    expect(normalizeLinkInput(raw)).toBeNull();
  });
});

describe('derivedLength', () => {
  it('counts what the server will store, in code points', () => {
    const doc = plainTextToDoc('💪 go\n\ngo');
    expect(derivedLength(doc)).toBe([...'💪 go\n\ngo'].length);
  });
});

describe('nextToolbarIndex', () => {
  it('moves along the toolbar with the arrow keys, wrapping at the ends', () => {
    expect(nextToolbarIndex(0, 'ArrowRight', 5)).toBe(1);
    expect(nextToolbarIndex(4, 'ArrowRight', 5)).toBe(0);
    expect(nextToolbarIndex(0, 'ArrowLeft', 5)).toBe(4);
  });

  it('jumps to the ends with Home and End', () => {
    expect(nextToolbarIndex(2, 'Home', 5)).toBe(0);
    expect(nextToolbarIndex(2, 'End', 5)).toBe(4);
  });

  it('leaves every other key to the browser', () => {
    expect(nextToolbarIndex(2, 'Enter', 5)).toBeNull();
    expect(nextToolbarIndex(2, 'Tab', 5)).toBeNull();
    expect(nextToolbarIndex(0, 'ArrowRight', 0)).toBeNull();
  });
});
