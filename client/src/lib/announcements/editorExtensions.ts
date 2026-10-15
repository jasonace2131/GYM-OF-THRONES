import type { Extensions } from '@tiptap/react';
import { Fragment, Slice, type Node as ProseMirrorNode } from '@tiptap/pm/model';
import StarterKit from '@tiptap/starter-kit';
import Image from '@tiptap/extension-image';
import Link from '@tiptap/extension-link';
import { isAllowedLinkHref } from '@got/shared';

/**
 * The editor's schema — cut down to exactly what the server's allowlist
 * accepts (`ANNOUNCEMENT_NODE_TYPES` / `ANNOUNCEMENT_MARK_TYPES`, pinned by
 * editorExtensions.test.ts).
 *
 * An editor that can produce something the API refuses is an editor that
 * shows a button, lets somebody use it, and then fails their Post with a 400.
 * So code, code blocks, strike and underline are switched off here rather than
 * merely left out of the toolbar — their keyboard shortcuts and markdown
 * shortcuts would otherwise still create them.
 */
export function announcementExtensions(): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [2, 3] },
      code: false,
      codeBlock: false,
      strike: false,
      underline: false,
      // Configured below with the shared URL rule instead of StarterKit's own.
      link: false,
    }),
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      defaultProtocol: 'https',
      protocols: ['http', 'https', 'mailto'],
      // The same rule the server applies, so a pasted or typed link the API
      // would refuse never becomes a link in the first place. Tiptap's own
      // check (≥ 2.10.4) already refuses javascript:; this narrows it further.
      isAllowedUri: (url) => isAllowedLinkHref(url),
      HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: '_blank' },
    }),
    // Block images only, never base64, and no `![alt](src)` input rule — that
    // rule would let an admin type a hotlinked image the API then refuses.
    Image.extend({
      addInputRules() {
        return [];
      },
    }).configure({ inline: false, allowBase64: false }),
  ];
}

/**
 * Pasted content with every image not from our bucket removed.
 *
 * Copying a paragraph from another website brings its `<img>` tags with it.
 * Those would be hotlinks — and the server refuses them — so they are dropped
 * at paste time, where the admin can see it happen, rather than at Post.
 */
export function dropForeignImages(slice: Slice, keep: (src: string) => boolean): Slice {
  return new Slice(filterFragment(slice.content, keep), slice.openStart, slice.openEnd);
}

function filterFragment(fragment: Fragment, keep: (src: string) => boolean): Fragment {
  const nodes: ProseMirrorNode[] = [];
  fragment.forEach((node) => {
    if (node.type.name === 'image' && !keep(String(node.attrs['src'] ?? ''))) return;
    nodes.push(node.isText ? node : node.copy(filterFragment(node.content, keep)));
  });
  return Fragment.fromArray(nodes);
}
