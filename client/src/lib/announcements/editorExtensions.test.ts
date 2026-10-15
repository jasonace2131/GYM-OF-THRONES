import { describe, expect, it } from 'vitest';
// @tiptap/react re-exports @tiptap/core; the client declares only the former.
import { Editor, getSchema } from '@tiptap/react';
import { Fragment, Slice } from '@tiptap/pm/model';
import { ANNOUNCEMENT_MARK_TYPES, ANNOUNCEMENT_NODE_TYPES } from '@got/shared';
import { announcementExtensions, dropForeignImages } from './editorExtensions';
import { sanitizeAnnouncementDoc } from '../../../../server/src/announcements/rich-content';

const BASE = 'https://abcdefgh.supabase.co/storage/v1/object/public/announcements/';
const OURS = `${BASE}announcements/0b6a3c4e-5d2f-4a1b-8c9d-0e1f2a3b4c5d.webp`;

describe('announcementExtensions', () => {
  const schema = getSchema(announcementExtensions());

  /**
   * The editor must not be able to PRODUCE anything the server refuses. If a
   * Tiptap upgrade adds a node or mark to StarterKit, this fails before an
   * admin meets a 400 for a button they were shown.
   */
  it('has exactly the node types the server allows', () => {
    expect(Object.keys(schema.nodes).sort()).toEqual([...ANNOUNCEMENT_NODE_TYPES].sort());
  });

  it('has exactly the marks the server allows', () => {
    expect(Object.keys(schema.marks).sort()).toEqual([...ANNOUNCEMENT_MARK_TYPES].sort());
  });

  it('keeps images at block level, as the server expects', () => {
    expect(schema.nodes['image']?.isBlock).toBe(true);
  });

  it('loads a document shaped like the server’s sanitised output', () => {
    const stored = {
      type: 'doc',
      content: [
        { type: 'heading', attrs: { level: 3 }, content: [{ type: 'text', text: 'Hours' }] },
        {
          type: 'orderedList',
          attrs: { start: 2 },
          content: [
            {
              type: 'listItem',
              content: [
                {
                  type: 'paragraph',
                  content: [
                    {
                      type: 'text',
                      text: 'link',
                      marks: [{ type: 'link', attrs: { href: 'https://example.com' } }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: 'image', attrs: { src: OURS, alt: 'x', width: 1600, height: 900 } },
      ],
    };
    expect(() => schema.nodeFromJSON(stored).check()).not.toThrow();
  });

  describe('in a live editor', () => {
    const editorWith = (content: string): Editor =>
      new Editor({ extensions: announcementExtensions(), content });

    it('refuses a javascript: link from pasted HTML', () => {
      const editor = editorWith('<p><a href="javascript:alert(1)">click</a></p>');
      expect(JSON.stringify(editor.getJSON())).not.toContain('javascript:');
      editor.destroy();
    });

    it('refuses a data: image from pasted HTML', () => {
      const editor = editorWith('<p>x</p><img src="data:image/png;base64,iVBORw0KGgo=">');
      expect(JSON.stringify(editor.getJSON())).not.toContain('data:image');
      editor.destroy();
    });

    it('drops code, strike and underline rather than keeping them', () => {
      const editor = editorWith('<p><code>a</code><s>b</s><u>c</u></p><pre><code>d</code></pre>');
      const types = JSON.stringify(editor.getJSON());
      for (const refused of ['"code"', '"strike"', '"underline"', '"codeBlock"']) {
        expect(types).not.toContain(refused);
      }
      editor.destroy();
    });

    it('refuses to set a javascript: link through the command', () => {
      const editor = editorWith('<p>click</p>');
      editor.commands.selectAll();
      editor.commands.setLink({ href: 'javascript:alert(1)' });
      expect(JSON.stringify(editor.getJSON())).not.toContain('javascript:');
      editor.destroy();
    });

    it('does not turn typed markdown image syntax into an image', () => {
      const editor = editorWith('<p></p>');
      editor.commands.insertContent('![x](https://evil.example/x.png) ');
      expect(JSON.stringify(editor.getJSON())).not.toContain('"image"');
      editor.destroy();
    });

    /**
     * THE CONTRACT, END TO END: what this editor emits is what the server's
     * own validator accepts. Imported across workspaces on purpose — the
     * server file is pure and depends only on @got/shared — so the two sides
     * cannot drift without this test noticing.
     */
    it('produces JSON the server’s allowlist accepts, with every toolbar feature used', () => {
      const editor = editorWith(
        '<h2>Holiday hours</h2>' +
          '<p><strong>Bold</strong>, <em>italic</em> and <a href="https://gymofthrones.ph">a link</a><br>next line</p>' +
          '<h3>Classes</h3>' +
          '<ul><li><p>One</p></li></ul>' +
          '<ol start="3"><li><p>Three</p></li></ol>' +
          '<blockquote><p>Quote</p></blockquote><hr>',
      );
      editor.commands.insertContentAt(editor.state.doc.content.size, {
        type: 'image',
        attrs: { src: OURS, alt: 'Rack', width: 1600, height: 900 },
      });

      const result = sanitizeAnnouncementDoc(editor.getJSON(), { imageBaseUrl: BASE });

      expect(result.ok ? null : result.reason).toBeNull();
      if (result.ok) {
        expect(result.text).toContain('Holiday hours');
        expect(JSON.stringify(result.doc)).toContain(OURS);
      }
      editor.destroy();
    });
  });
});

describe('dropForeignImages', () => {
  const schema = getSchema(announcementExtensions());
  const image = (src: string) => schema.nodes['image'].create({ src });
  const para = (text: string) => schema.nodes['paragraph'].create(null, schema.text(text));
  const keepOurs = (src: string): boolean => src.startsWith(BASE);

  it('keeps our images and everything else, and drops images from elsewhere', () => {
    const slice = new Slice(
      Fragment.fromArray([para('a'), image(OURS), image('https://evil.example/x.png'), para('b')]),
      0,
      0,
    );

    const out = dropForeignImages(slice, keepOurs);

    const types: string[] = [];
    const srcs: string[] = [];
    out.content.forEach((node) => {
      types.push(node.type.name);
      if (node.type.name === 'image') srcs.push(String(node.attrs['src']));
    });
    expect(types).toEqual(['paragraph', 'image', 'paragraph']);
    expect(srcs).toEqual([OURS]);
  });

  it('reaches images nested inside lists and quotes', () => {
    const nested = schema.nodes['blockquote'].create(null, [
      para('q'),
      image('https://evil.example/x.png'),
    ]);
    const out = dropForeignImages(new Slice(Fragment.from(nested), 0, 0), keepOurs);
    expect(JSON.stringify(out.content.toJSON())).not.toContain('evil.example');
  });
});
