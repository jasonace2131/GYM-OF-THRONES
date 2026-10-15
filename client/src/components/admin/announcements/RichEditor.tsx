'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import {
  Bold,
  Heading2,
  Heading3,
  ImagePlus,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Redo2,
  Undo2,
} from 'lucide-react';
import { isAnnouncementImageUrl, type AnnouncementDoc } from '@got/shared';
import { announcementExtensions, dropForeignImages } from '@/lib/announcements/editorExtensions';
import { clientImageBase, nextToolbarIndex, normalizeLinkInput } from '@/lib/announcements/rich';
import type { UploadedImage } from '@/lib/announcements/imageUpload';

/**
 * The admin's rich-text composer — Tiptap, headless, styled with the
 * console's own tokens (`.a-rich-*` in admin.css). No Tailwind here: this
 * folder is not Tailwind-scanned, and the containment gate keeps it that way.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * IT CAN ONLY MAKE WHAT THE SERVER ACCEPTS. The schema is cut to the server's
 * allowlist (lib/announcements/editorExtensions.ts, pinned by a test that
 * runs real editor output through the server's validator). Links go through
 * the same shared URL rule the server applies; pasted images from other sites
 * are dropped at paste time; an image enters only by being uploaded here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Accessibility: the toolbar is a WAI-ARIA toolbar — one Tab stop, arrow keys
 * between buttons, `aria-pressed` on every toggle — and the editing area is a
 * labelled multi-line textbox. Upload progress and errors are announced.
 *
 * `immediatelyRender: false` because this renders inside a statically
 * prerendered route; creating the editor during SSR would mismatch on
 * hydration.
 */

export interface RichEditorProps {
  /** The document to start from. Read once, on mount. */
  initialDoc: AnnouncementDoc;
  onChange: (doc: AnnouncementDoc) => void;
  /** False hides the image button and refuses pasted images. */
  imagesEnabled: boolean;
  onUploadImage: (file: File) => Promise<UploadedImage>;
  /** The id of the visible label for the editing area. */
  labelledBy: string;
  disabled?: boolean;
}

interface ToolState {
  h2: boolean;
  h3: boolean;
  bold: boolean;
  italic: boolean;
  bullet: boolean;
  ordered: boolean;
  link: boolean;
  image: boolean;
  imageAlt: string;
  canUndo: boolean;
  canRedo: boolean;
}

interface Tool {
  id: string;
  label: string;
  icon: ReactNode;
  /** Undefined for an action (undo); a boolean for a toggle (bold). */
  pressed?: boolean;
  unavailable?: boolean;
  run: () => void;
}

const imageFiles = (list: FileList | null | undefined): File[] =>
  Array.from(list ?? []).filter((file) => file.type.startsWith('image/'));

export function RichEditor({
  initialDoc,
  onChange,
  imagesEnabled,
  onUploadImage,
  labelledBy,
  disabled = false,
}: RichEditorProps) {
  const [uploading, setUploading] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkDraft, setLinkDraft] = useState('');
  const [linkError, setLinkError] = useState<string | null>(null);
  const [focusIndex, setFocusIndex] = useState(0);

  // State rather than a ref: the toolbar's Image action is built during render.
  const [fileInput, setFileInput] = useState<HTMLInputElement | null>(null);
  const editorRef = useRef<Editor | null>(null);

  // The editor is created once; these refs let its long-lived handlers see
  // the current props without recreating it.
  const onChangeRef = useRef(onChange);
  const uploadRef = useRef<(files: File[]) => void>(() => undefined);
  const imagesEnabledRef = useRef(imagesEnabled);
  useEffect(() => {
    onChangeRef.current = onChange;
    imagesEnabledRef.current = imagesEnabled;
  });

  const imageBase = useMemo(() => clientImageBase(), []);
  const [extensions] = useState(announcementExtensions);
  const [content] = useState(initialDoc);

  const editorProps = useMemo(
    () => ({
      attributes: {
        class: 'a-rich-prose',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-labelledby': labelledBy,
      },
      // Images from other sites arrive with copied HTML. They would be
      // hotlinks the API refuses, so they go now, visibly, not at Post.
      transformPasted: (slice: Parameters<typeof dropForeignImages>[0]) =>
        dropForeignImages(slice, (src) => isAnnouncementImageUrl(src, imageBase)),
      handlePaste: (_view: unknown, event: ClipboardEvent) => {
        const files = imageFiles(event.clipboardData?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        uploadRef.current(files);
        return true;
      },
      handleDrop: (_view: unknown, event: DragEvent, _slice: unknown, moved: boolean) => {
        if (moved) return false;
        const files = imageFiles(event.dataTransfer?.files);
        if (files.length === 0) return false;
        event.preventDefault();
        uploadRef.current(files);
        return true;
      },
    }),
    [imageBase, labelledBy],
  );

  const editor = useEditor({
    extensions,
    content,
    immediatelyRender: false,
    shouldRerenderOnTransaction: false,
    editorProps,
    onUpdate: ({ editor: current }) => {
      onChangeRef.current(current.getJSON() as AnnouncementDoc);
    },
  });

  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  const state = useEditorState({
    editor,
    selector: ({ editor: current }): ToolState | null =>
      current === null
        ? null
        : {
            h2: current.isActive('heading', { level: 2 }),
            h3: current.isActive('heading', { level: 3 }),
            bold: current.isActive('bold'),
            italic: current.isActive('italic'),
            bullet: current.isActive('bulletList'),
            ordered: current.isActive('orderedList'),
            link: current.isActive('link'),
            image: current.isActive('image'),
            imageAlt: String(current.getAttributes('image')['alt'] ?? ''),
            canUndo: current.can().undo(),
            canRedo: current.can().redo(),
          },
  });

  const uploadFiles = useCallback(
    (files: File[]): void => {
      if (!imagesEnabledRef.current) {
        setNotice(
          'Images are not available on this server — the notice can still be posted as text.',
        );
        return;
      }
      setNotice(null);
      for (const file of files) {
        setUploading((n) => n + 1);
        onUploadImage(file)
          .then((image) => {
            editorRef.current
              ?.chain()
              .focus()
              .setImage({ src: image.src, alt: '', width: image.width, height: image.height })
              .run();
          })
          .catch((caught: unknown) => {
            setNotice(caught instanceof Error ? caught.message : 'The image did not upload.');
          })
          .finally(() => setUploading((n) => n - 1));
      }
    },
    [onUploadImage],
  );

  useEffect(() => {
    uploadRef.current = uploadFiles;
  }, [uploadFiles]);

  const openLink = (): void => {
    if (editor === null) return;
    setLinkDraft(String(editor.getAttributes('link')['href'] ?? ''));
    setLinkError(null);
    setLinkOpen(true);
  };

  const applyLink = (): void => {
    if (editor === null) return;
    const href = normalizeLinkInput(linkDraft);
    if (href === null) {
      setLinkError('Use a web address (https://…) or an email address.');
      return;
    }
    if (editor.state.selection.empty && !editor.isActive('link')) {
      // Nothing selected: the address itself becomes the linked text.
      editor
        .chain()
        .focus()
        .insertContent({ type: 'text', text: href, marks: [{ type: 'link', attrs: { href } }] })
        .run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setLinkOpen(false);
  };

  const removeLink = (): void => {
    editor?.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkOpen(false);
  };

  const tools: Tool[] =
    editor === null || state === null
      ? []
      : [
          {
            id: 'h2',
            label: 'Heading',
            icon: <Heading2 aria-hidden size={17} />,
            pressed: state.h2,
            run: () => editor.chain().focus().toggleHeading({ level: 2 }).run(),
          },
          {
            id: 'h3',
            label: 'Subheading',
            icon: <Heading3 aria-hidden size={17} />,
            pressed: state.h3,
            run: () => editor.chain().focus().toggleHeading({ level: 3 }).run(),
          },
          {
            id: 'bold',
            label: 'Bold',
            icon: <Bold aria-hidden size={17} />,
            pressed: state.bold,
            run: () => editor.chain().focus().toggleBold().run(),
          },
          {
            id: 'italic',
            label: 'Italic',
            icon: <Italic aria-hidden size={17} />,
            pressed: state.italic,
            run: () => editor.chain().focus().toggleItalic().run(),
          },
          {
            id: 'bullet',
            label: 'Bulleted list',
            icon: <List aria-hidden size={17} />,
            pressed: state.bullet,
            run: () => editor.chain().focus().toggleBulletList().run(),
          },
          {
            id: 'ordered',
            label: 'Numbered list',
            icon: <ListOrdered aria-hidden size={17} />,
            pressed: state.ordered,
            run: () => editor.chain().focus().toggleOrderedList().run(),
          },
          {
            id: 'link',
            label: 'Link',
            icon: <LinkIcon aria-hidden size={17} />,
            pressed: state.link || linkOpen,
            run: () => (linkOpen ? setLinkOpen(false) : openLink()),
          },
          ...(imagesEnabled
            ? [
                {
                  id: 'image',
                  label: 'Insert image',
                  icon: <ImagePlus aria-hidden size={17} />,
                  run: () => fileInput?.click(),
                },
              ]
            : []),
          {
            id: 'undo',
            label: 'Undo',
            icon: <Undo2 aria-hidden size={17} />,
            unavailable: !state.canUndo,
            run: () => editor.chain().focus().undo().run(),
          },
          {
            id: 'redo',
            label: 'Redo',
            icon: <Redo2 aria-hidden size={17} />,
            unavailable: !state.canRedo,
            run: () => editor.chain().focus().redo().run(),
          },
        ];

  const activeIndex = Math.min(focusIndex, Math.max(0, tools.length - 1));

  const onToolbarKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    const next = nextToolbarIndex(activeIndex, event.key, tools.length);
    if (next === null) return;
    event.preventDefault();
    setFocusIndex(next);
    event.currentTarget.querySelectorAll<HTMLButtonElement>('.a-rich-tool')[next]?.focus();
  };

  return (
    <div className="a-rich" data-disabled={disabled || undefined}>
      <div
        role="toolbar"
        aria-label="Formatting"
        className="a-rich-toolbar"
        onKeyDown={onToolbarKey}
      >
        {tools.map((tool, index) => (
          <button
            key={tool.id}
            type="button"
            className="a-rich-tool"
            title={tool.label}
            aria-label={tool.label}
            aria-pressed={tool.pressed}
            aria-disabled={disabled || tool.unavailable || undefined}
            tabIndex={index === activeIndex ? 0 : -1}
            onFocus={() => setFocusIndex(index)}
            // Keep the editor's selection: a mousedown on a toolbar button
            // would otherwise blur the editor and collapse what was selected.
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              if (disabled || tool.unavailable) return;
              tool.run();
            }}
          >
            {tool.icon}
          </button>
        ))}
        {uploading > 0 ? <span className="a-rich-status">Uploading image…</span> : null}
      </div>

      {linkOpen ? (
        <div className="a-rich-panel">
          <label className="a-rich-panel-field">
            <span className="a-person-sub">LINK ADDRESS</span>
            <input
              className="a-input"
              type="text"
              inputMode="url"
              autoFocus
              value={linkDraft}
              placeholder="https://… or name@example.com"
              aria-invalid={linkError !== null || undefined}
              onChange={(event) => {
                setLinkDraft(event.target.value);
                setLinkError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  applyLink();
                } else if (event.key === 'Escape') {
                  event.preventDefault();
                  setLinkOpen(false);
                  editor?.commands.focus();
                }
              }}
            />
          </label>
          <div className="a-rich-panel-actions">
            <button type="button" className="p-btn p-btn-gold p-btn-sm" onClick={applyLink}>
              Apply
            </button>
            {state?.link ? (
              <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={removeLink}>
                Remove link
              </button>
            ) : null}
            <button
              type="button"
              className="p-btn p-btn-ghost p-btn-sm"
              onClick={() => {
                setLinkOpen(false);
                editor?.commands.focus();
              }}
            >
              Cancel
            </button>
          </div>
          {linkError === null ? null : (
            <p role="alert" className="a-rich-error">
              {linkError}
            </p>
          )}
        </div>
      ) : null}

      {state?.image ? (
        <div className="a-rich-panel">
          <label className="a-rich-panel-field">
            <span className="a-person-sub">
              IMAGE DESCRIPTION — read aloud to members using a screen reader
            </span>
            <input
              className="a-input"
              type="text"
              maxLength={300}
              value={state.imageAlt}
              placeholder="e.g. The new squat racks by the window"
              onChange={(event) =>
                editor?.chain().updateAttributes('image', { alt: event.target.value }).run()
              }
            />
          </label>
        </div>
      ) : null}

      <EditorContent editor={editor} className="a-rich-surface" />

      {imagesEnabled ? (
        <input
          ref={setFileInput}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            uploadFiles(imageFiles(event.target.files));
            event.target.value = '';
          }}
        />
      ) : null}

      <p role="status" aria-live="polite" className="a-rich-notice">
        {notice ?? ''}
      </p>
    </div>
  );
}
