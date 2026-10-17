'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import dynamic from 'next/dynamic';
import {
  ANNOUNCEMENT_CONTENT_MAX,
  PERMISSIONS,
  type Announcement,
  type AnnouncementDoc,
} from '@got/shared';
import { ApiError } from '@/lib/api';
import { adminApi } from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { formatGymTime } from '@/lib/gymTime';
import { derivedLength, plainTextToDoc } from '@/lib/announcements/rich';
import { announcementPayload, composerProblem } from '@/lib/announcements/compose';
import {
  browserPipeline,
  putToStorage,
  uploadAnnouncementImage,
  type UploadedImage,
} from '@/lib/announcements/imageUpload';
import { Badge, Card, CardHead, EmptyState, Skeleton } from '@/components/portal/ui';
import { usePermission } from '@/components/rbac/MeProvider';
import { ConfirmDialog, useConfirmAction } from '@/components/admin/actions/ConfirmDialog';
import { NoticeCover, RichContent } from '@/components/announcements/RichContent';

/**
 * The editor — Tiptap and ProseMirror, about 130 KB gzipped — loads only when
 * somebody opens the composer, not for everyone who just reads the board.
 * `ssr: false` because it cannot render on the server anyway
 * (`immediatelyRender: false`).
 */
const RichEditor = dynamic(
  () => import('@/components/admin/announcements/RichEditor').then((mod) => mod.RichEditor),
  { ssr: false, loading: () => <Skeleton height={220} /> },
);

/**
 * The noticeboard, from the staff side.
 *
 * Reads the SAME `GET /announcements` the member portal reads — there is no
 * admin-only list. One query and one ordering means the board staff edit and
 * the board members see cannot disagree about what is pinned.
 *
 * Delete is a HARD delete and says so. An announcement is not a financial
 * record: nothing references it and no report reconciles against it, so
 * keeping a withdrawn notice around only creates a way for it to reappear.
 *
 * The body is RICH TEXT (Tiptap → ProseMirror JSON), validated against an
 * allowlist on the server, which also derives the plain text previews and the
 * bell read. Every write — post, edit, pin, delete — is confirmed in the
 * console's one ConfirmDialog, and audited server-side.
 */

const GYM_TIMEZONE = 'Asia/Manila';
const TITLE_MAX = 120;
const CONTENT_MAX = ANNOUNCEMENT_CONTENT_MAX;

/** Check, resize, sign, PUT to storage — the composer's one upload path. */
const uploadImage = (file: File): Promise<UploadedImage> =>
  uploadAnnouncementImage(file, {
    pipeline: browserPipeline,
    sign: adminApi.signAnnouncementUpload,
    put: putToStorage,
  });

export default function AdminAnnouncementsPage() {
  // The shell hides nav links a caller cannot use; this screen rendered its
  // WRITE controls to anyone who reached it, so a FRONT_DESK account saw a
  // "Post an announcement" button that 403s on submit. Hiding a control is
  // not a security control — the route is checked server-side either way —
  // but showing a door that does not open teaches staff to distrust the UI.
  const canWrite = usePermission(PERMISSIONS.ANNOUNCEMENT_CREATE);

  const board = useAdminQuery(
    useCallback(() => adminApi.announcements({ page: 1, limit: 50 }), []),
    'announcements',
  );

  const [editing, setEditing] = useState<Announcement | null>(null);
  const [composing, setComposing] = useState(false);

  const close = (): void => {
    setEditing(null);
    setComposing(false);
  };

  const afterWrite = (): void => {
    close();
    board.reload();
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {composing || editing !== null ? (
        <Composer
          key={editing?.id ?? 'new'}
          existing={editing}
          onSaved={afterWrite}
          onCancel={close}
        />
      ) : (
        canWrite && (
          <div>
            <button type="button" className="p-btn p-btn-gold" onClick={() => setComposing(true)}>
              Post an announcement
            </button>
          </div>
        )
      )}

      <Card padded={false}>
        <CardHead
          title="Posted"
          action={
            <span className="a-person-sub">
              {board.data === null ? '' : `${board.data.total} total`}
            </span>
          }
        />

        {board.loading && board.data === null ? (
          <div className="p-card-pad">
            <Skeleton height={120} />
          </div>
        ) : board.error !== null ? (
          <EmptyState title="Could not load announcements" hint={board.error} />
        ) : board.data === null || board.data.items.length === 0 ? (
          <EmptyState
            title="Nothing posted yet"
            hint="Closures, price changes and events go here. Members see them immediately."
          />
        ) : (
          <div>
            {board.data.items.map((notice) => (
              <Row
                key={notice.id}
                notice={notice}
                onEdit={() => {
                  setComposing(false);
                  setEditing(notice);
                }}
                onChanged={() => board.reload()}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function Row({
  notice,
  onEdit,
  onChanged,
}: {
  notice: Announcement;
  onEdit: () => void;
  onChanged: () => void;
}) {
  // Pin and Edit are `announcement.update`, Delete is `announcement.delete` —
  // the keys their routes check, rather than `.create` standing in for all
  // three and showing controls that 403.
  const canUpdate = usePermission(PERMISSIONS.ANNOUNCEMENT_UPDATE);
  const canDelete = usePermission(PERMISSIONS.ANNOUNCEMENT_DELETE);

  // Which write is waiting on its confirmation. Pin, unpin and delete each
  // change what every member sees, so none of them fires on one click.
  const [asking, setAsking] = useState<'pin' | 'delete' | null>(null);
  const { busy, error, run, reset } = useConfirmAction();

  const close = (): void => {
    if (busy) return;
    reset();
    setAsking(null);
  };

  const confirm = (): void => {
    const write =
      asking === 'delete'
        ? () => adminApi.deleteAnnouncement(notice.id)
        : () => adminApi.updateAnnouncement(notice.id, { isPinned: !notice.isPinned });
    void run(write).then((ok) => {
      if (!ok) return;
      reset();
      setAsking(null);
      onChanged();
    });
  };

  return (
    <div style={{ padding: '14px 18px', borderBottom: '1px solid var(--p-border)' }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <strong style={{ flex: 1, minWidth: 0 }}>{notice.title}</strong>
        {notice.isPinned ? <Badge tone="warn">Pinned</Badge> : null}
      </div>

      {/* Staff see the notice as members do: the cover, then the rich body
          through the same renderer — or plain text for an old notice. */}
      {notice.coverImageUrl === null ? null : (
        <div style={{ marginTop: 8, maxWidth: 360 }}>
          <NoticeCover url={notice.coverImageUrl} />
        </div>
      )}
      <div style={{ margin: '6px 0 0', color: 'var(--p-ink2)', fontSize: 13.5, lineHeight: 1.55 }}>
        {notice.contentJson === null ? (
          <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{notice.content}</p>
        ) : (
          <RichContent doc={notice.contentJson} fallback={notice.content} />
        )}
      </div>

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginTop: 10,
          flexWrap: 'wrap',
        }}
      >
        <span className="a-person-sub" style={{ flex: 1, minWidth: 0 }}>
          {notice.author.firstName} {notice.author.lastName} ·{' '}
          {formatGymTime(notice.createdAt, GYM_TIMEZONE, {
            day: 'numeric',
            month: 'short',
            year: 'numeric',
          })}
        </span>

        {canUpdate && (
        <button
          type="button"
          className="p-btn p-btn-ghost p-btn-sm"
          disabled={busy}
          onClick={() => setAsking('pin')}
        >
          {notice.isPinned ? 'Unpin' : 'Pin'}
        </button>
        )}

        {canUpdate && (
        <button type="button" className="p-btn p-btn-ghost p-btn-sm" disabled={busy} onClick={onEdit}>
          Edit
        </button>
        )}

        {/* Asked in the console's one dialog rather than a window.confirm:
            the delete is permanent and the title is named in the question. */}
        {canDelete && (
        <button
          type="button"
          className="p-btn p-btn-ghost p-btn-sm"
          disabled={busy}
          onClick={() => setAsking('delete')}
        >
          Delete
        </button>
        )}
      </div>

      <ConfirmDialog
        open={asking !== null}
        title={
          asking === 'delete'
            ? `Delete “${notice.title}”?`
            : notice.isPinned
              ? `Unpin “${notice.title}”?`
              : `Pin “${notice.title}”?`
        }
        consequence={
          asking === 'delete'
            ? 'It is removed permanently members stop seeing it and it cannot be restored.'
            : notice.isPinned
              ? "It drops back into date order on every member's board."
              : "It moves to the top of every member's board and stays there until you unpin it."
        }
        confirmLabel={asking === 'delete' ? 'Delete' : notice.isPinned ? 'Unpin' : 'Pin'}
        cancelLabel={
          asking === 'delete' ? 'Keep it' : notice.isPinned ? 'Leave it pinned' : 'Leave it unpinned'
        }
        tone={asking === 'delete' ? 'danger' : 'default'}
        busy={busy}
        error={error}
        onConfirm={confirm}
        onClose={close}
      />
    </div>
  );
}

/**
 * Whether this server can take images at all — false without
 * SUPABASE_SERVICE_KEY. Until the answer arrives the image controls stay
 * hidden rather than flashing into view and then vanishing.
 */
function useImagesEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let cancelled = false;
    adminApi
      .announcementUploadStatus()
      .then((status) => {
        if (!cancelled) setEnabled(status.enabled);
      })
      .catch(() => {
        if (!cancelled) setEnabled(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return enabled;
}

function Composer({
  existing,
  onSaved,
  onCancel,
}: {
  existing: Announcement | null;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState(existing?.title ?? '');
  // An old plain notice opens as paragraphs; saving it untouched leaves it plain.
  const [initialDoc] = useState<AnnouncementDoc>(
    () => existing?.contentJson ?? plainTextToDoc(existing?.content ?? ''),
  );
  const [doc, setDoc] = useState<AnnouncementDoc>(initialDoc);
  const [bodyTouched, setBodyTouched] = useState(false);
  const [cover, setCover] = useState<string | null>(existing?.coverImageUrl ?? null);
  const [isPinned, setPinned] = useState(existing?.isPinned ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Posting reaches every member at once, so it is confirmed first.
  const [confirming, setConfirming] = useState(false);

  const imagesEnabled = useImagesEnabled();
  const messageLabel = useId();
  const length = derivedLength(doc);
  const problem = composerProblem(title, doc);

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const payload = announcementPayload({ existing, title, doc, bodyTouched, cover, isPinned });
      if (existing === null) {
        await adminApi.createAnnouncement(payload);
      } else {
        await adminApi.updateAnnouncement(existing.id, payload);
      }
      setConfirming(false);
      onSaved();
    } catch (caught) {
      // The server's allowlist speaks in the admin's terms ("Links must start
      // with http://…"), so its message is shown as it is.
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card style={{ borderColor: 'var(--gold)' }}>
      <CardHead
        title={existing === null ? 'New announcement' : 'Edit announcement'}
        action={
          <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onCancel}>
            Cancel
          </button>
        }
      />

      <form
        className="a-sheet"
        onSubmit={(event) => {
          event.preventDefault();
          setError(null);
          setConfirming(true);
        }}
      >
        <label>
          <span className="a-person-sub">
            TITLE — {TITLE_MAX - title.length} characters left
          </span>
          <input
            className="a-input"
            value={title}
            required
            maxLength={TITLE_MAX}
            onChange={(event) => setTitle(event.target.value)}
            placeholder="Gym closes early this Saturday"
          />
        </label>

        <CoverPicker cover={cover} onChange={setCover} imagesEnabled={imagesEnabled} />

        <div>
          <span id={messageLabel} className="a-person-sub">
            MESSAGE — {CONTENT_MAX - length} characters left
          </span>
          <RichEditor
            initialDoc={initialDoc}
            labelledBy={messageLabel}
            imagesEnabled={imagesEnabled}
            onUploadImage={uploadImage}
            disabled={busy}
            onChange={(next) => {
              setDoc(next);
              setBodyTouched(true);
            }}
          />
        </div>

        {/* The same renderer members get, fed the same document. */}
        <details className="a-rich-preview" open>
          <summary className="a-person-sub">PREVIEW — as members will see it</summary>
          <div className="a-rich-preview-body">
            <strong style={{ display: 'block', fontSize: 15, marginBottom: 8 }}>
              {title.trim() === '' ? 'Untitled' : title.trim()}
            </strong>
            {cover === null ? null : (
              <div style={{ marginBottom: 10 }}>
                <NoticeCover url={cover} />
              </div>
            )}
            <div style={{ color: 'var(--p-ink2)', fontSize: 14.5, lineHeight: 1.6 }}>
              <RichContent doc={doc} fallback="" />
            </div>
          </div>
        </details>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={isPinned}
            onChange={(event) => setPinned(event.target.checked)}
          />
          <span style={{ fontSize: 14 }}>Pin to the top</span>
        </label>

        {error === null ? null : (
          <p role="alert" style={{ color: 'var(--p-danger)', fontSize: 14, margin: 0 }}>
            {error}
          </p>
        )}

        <button
          type="submit"
          className="p-btn p-btn-gold"
          disabled={busy || problem !== null}
          title={problem ?? undefined}
        >
          {busy ? 'Saving…' : existing === null ? 'Post it' : 'Save changes'}
        </button>
      </form>

      <ConfirmDialog
        open={confirming}
        title={
          existing === null ? `Post “${title.trim()}”?` : `Save changes to “${title.trim()}”?`
        }
        consequence={
          existing === null
            ? `Every member sees it on their dashboard straight away${isPinned ? ', pinned to the top' : ''}.`
            : `Members see the new version straight away${isPinned ? ', pinned to the top' : ''}.`
        }
        confirmLabel={existing === null ? 'Post it' : 'Save changes'}
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    </Card>
  );
}

/**
 * The optional image above the body. Uploaded through the same resize-and-
 * sign path as images in the text; removing it only unlinks it here (the
 * nightly cleanup deletes the object once nothing references it).
 */
function CoverPicker({
  cover,
  onChange,
  imagesEnabled,
}: {
  cover: string | null;
  onChange: (url: string | null) => void;
  imagesEnabled: boolean;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);

  if (!imagesEnabled && cover === null) return null;

  const choose = (file: File | undefined): void => {
    if (file === undefined) return;
    setUploading(true);
    setProblem(null);
    uploadImage(file)
      .then((image) => onChange(image.src))
      .catch((caught: unknown) =>
        setProblem(caught instanceof Error ? caught.message : 'The image did not upload.'),
      )
      .finally(() => setUploading(false));
  };

  return (
    <div className="a-rich-cover">
      <span className="a-person-sub">COVER IMAGE — optional, shown above the message</span>
      {cover === null ? null : (
        <div style={{ maxWidth: 360 }}>
          <NoticeCover url={cover} />
        </div>
      )}
      <div className="a-rich-panel-actions">
        {imagesEnabled ? (
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            disabled={uploading}
            onClick={() => input.current?.click()}
          >
            {uploading ? 'Uploading…' : cover === null ? 'Add a cover image' : 'Replace'}
          </button>
        ) : null}
        {cover === null ? null : (
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            disabled={uploading}
            onClick={() => onChange(null)}
          >
            Remove cover
          </button>
        )}
      </div>
      {imagesEnabled ? (
        <input
          ref={input}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          className="sr-only"
          tabIndex={-1}
          aria-hidden
          onChange={(event) => {
            choose(event.target.files?.[0]);
            event.target.value = '';
          }}
        />
      ) : null}
      <p role="status" aria-live="polite" className="a-rich-notice">
        {problem ?? ''}
      </p>
    </div>
  );
}
