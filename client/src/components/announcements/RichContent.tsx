import type { ReactNode } from 'react';
import { renderJSONContentToReactElement } from '@tiptap/static-renderer/json/react';
import type { AnnouncementDoc } from '@got/shared';
import {
  clientImageBase,
  headingTag,
  imageAttributes,
  linkAttributes,
} from '@/lib/announcements/rich';
import { cn } from '@/lib/utils';

/**
 * A rich notice, rendered — Tiptap's static renderer, straight to React
 * elements.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NO HTML, ANYWHERE. There is no `innerHTML` and no `dangerouslySetInnerHTML`
 * on this path: every node type maps to a component below, text is a React
 * text node (escaped by React), and the only attributes that reach the DOM
 * are the ones these components choose to set. A node type with no mapping
 * renders NOTHING; a mark with no mapping renders its text unstyled. So even
 * a document that somehow bypassed the server's allowlist can add neither a
 * tag nor an attribute to a member's page.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Used on the member dashboard, the coach dashboard, the console dashboard
 * (NoticeItem), the admin board and the composer's live preview. This folder
 * is Tailwind-scanned, and every surface that shows it loads tailwind.css.
 *
 * Deliberately hook-free: the renderer is rebuilt per render, which keeps its
 * element keys deterministic for a given document (a shared renderer's key
 * counter grows forever and would remount the whole body on every render).
 */

interface DocNode {
  type?: string;
  attrs?: Record<string, unknown>;
  text?: unknown;
  content?: unknown;
}

interface NodeArgs {
  node: DocNode;
  children?: ReactNode;
}

interface MarkArgs {
  mark: { attrs?: Record<string, unknown> };
  children?: ReactNode;
}

const isEmpty = (children: ReactNode): boolean =>
  children === undefined || children === null || (Array.isArray(children) && children.length === 0);

function buildRenderer(imageBase: string, headingBase: number) {
  return renderJSONContentToReactElement({
    nodeMapping: {
      doc: ({ children }: NodeArgs) => <>{children}</>,

      // An empty paragraph is a blank line the admin typed on purpose; a
      // <br> gives it the line of height the editor showed (as ProseMirror
      // itself does).
      paragraph: ({ children }: NodeArgs) => (
        <p className="m-0">{isEmpty(children) ? <br /> : children}</p>
      ),

      heading: ({ node, children }: NodeArgs) => {
        const Tag = headingTag(node.attrs?.['level'], headingBase);
        return (
          <Tag
            className={cn(
              'm-0 font-display leading-snug font-semibold text-foreground',
              node.attrs?.['level'] === 3 ? 'text-[14.5px]' : 'text-[16px]',
            )}
          >
            {children}
          </Tag>
        );
      },

      bulletList: ({ children }: NodeArgs) => (
        <ul className="m-0 list-disc pl-5 [&>li+li]:mt-1">{children}</ul>
      ),

      orderedList: ({ node, children }: NodeArgs) => {
        const start = node.attrs?.['start'];
        return (
          <ol
            start={Number.isInteger(start) ? (start as number) : undefined}
            className="m-0 list-decimal pl-5 [&>li+li]:mt-1"
          >
            {children}
          </ol>
        );
      },

      listItem: ({ children }: NodeArgs) => <li className="[&>*+*]:mt-1">{children}</li>,

      blockquote: ({ children }: NodeArgs) => (
        <blockquote className="m-0 border-l-2 border-gold pl-3 italic [&>*+*]:mt-2">
          {children}
        </blockquote>
      ),

      hardBreak: () => <br />,

      horizontalRule: () => <hr className="my-1 border-0 border-t border-border" />,

      image: ({ node }: NodeArgs) => {
        const image = imageAttributes(node.attrs, imageBase);
        if (image === null) return null;
        return (
          // A plain <img>, not next/image: the file is already resized to at
          // most 1600px and served from a public CDN bucket, and routing every
          // notice image through the optimiser would spend its quota for no
          // gain. Width and height reserve the space; CSS keeps the ratio.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.src}
            alt={image.alt}
            width={image.width}
            height={image.height}
            loading="lazy"
            decoding="async"
            className="block h-auto max-w-full rounded-md border border-border"
          />
        );
      },

      text: ({ node }: NodeArgs) => <>{typeof node.text === 'string' ? node.text : ''}</>,
    },

    markMapping: {
      bold: ({ children }: MarkArgs) => <strong className="font-semibold">{children}</strong>,
      italic: ({ children }: MarkArgs) => <em>{children}</em>,
      link: ({ mark, children }: MarkArgs) => {
        const link = linkAttributes(mark.attrs?.['href']);
        if (link === null) return <>{children}</>;
        return (
          <a
            {...link}
            className="font-medium text-gold-deep underline underline-offset-2 transition-colors hover:text-foreground"
          >
            {children}
          </a>
        );
      },
    },

    unhandledNode: () => null,
    unhandledMark: ({ children }: MarkArgs) => <>{children}</>,
  });
}

export function RichContent({
  doc,
  fallback,
  headingBase = 4,
  imageBase,
  className,
}: {
  doc: AnnouncementDoc;
  /** The derived plain text, shown if the document cannot be walked. */
  fallback: string;
  /** The element the document's H2 becomes. The notice title is usually an h3. */
  headingBase?: number;
  /** Overridable for tests; defaults to this deployment's public bucket. */
  imageBase?: string;
  className?: string;
}) {
  let body: ReactNode;
  try {
    body = buildRenderer(imageBase ?? clientImageBase(), headingBase)({ content: doc });
  } catch {
    // Malformed JSON cannot take the dashboard down: the plain text is always
    // there, derived by the server from this very document.
    return <div className={cn('whitespace-pre-wrap', className)}>{fallback}</div>;
  }

  return <div className={cn('[overflow-wrap:anywhere] [&>*+*]:mt-3', className)}>{body}</div>;
}

/**
 * The optional image above a notice's body. 16:9 with the space reserved, so
 * the text below does not jump when it arrives. Renders nothing for a URL
 * that is not from our bucket.
 */
export function NoticeCover({
  url,
  imageBase,
  className,
}: {
  url: string | null;
  imageBase?: string;
  className?: string;
}) {
  if (url === null) return null;
  const image = imageAttributes({ src: url }, imageBase ?? clientImageBase());
  if (image === null) return null;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={image.src}
      alt=""
      width={1600}
      height={900}
      loading="lazy"
      decoding="async"
      className={cn(
        'block aspect-video h-auto w-full rounded-lg border border-border object-cover',
        className,
      )}
    />
  );
}
