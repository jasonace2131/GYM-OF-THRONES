'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { Modal, ModalError } from '@/components/admin/Modal';
import { adminApi, gymDateTime } from '@/lib/adminApi';
import { TabletSetupWizard } from '@/components/admin/TabletSetupWizard';
import { ConfirmDialog, useConfirmAction } from '@/components/admin/actions/ConfirmDialog';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { downloadSetupCardPdf } from '@/lib/setupCardPdf';
import type { AdminStation } from '@/lib/adminApi';

/**
 * Check-in stations and the tablets that drive them.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THIS IS AN INCIDENT SURFACE, NOT A SETTINGS PAGE.
 *
 * Three of the four actions here are things a manager does while something is
 * going wrong, and the copy says so rather than dressing them as preferences:
 *
 *   TURN OFF      "that tablet was stolen", "that entrance is shut". Takes
 *                 effect on the very next scan, with no redeploy.
 *   NEW CODE      the per-station panic button. Every outstanding token for
 *                 THIS station dies within one slot — the display's own head
 *                 check is what makes it one slot and not one batch — with no
 *                 effect on any other station and no secret rotation.
 *   REVOKE        one tablet's access, independently of every other tablet
 *                 and of every member.
 *
 * Each is confirmed before it fires, through the console's one
 * `ConfirmDialog`. Not ceremony: two of them stop members getting through a
 * door, and a mis-click at 18:00 is a queue at the counter. Turning a screen
 * back ON is confirmed too — owner decision: every admin edit is.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default function AdminStationsPage() {
  const query = useAdminQuery(
    useCallback(() => adminApi.stations(), []),
    'stations',
  );
  const [settingUp, setSettingUp] = useState<AdminStation | null>(null);
  const [printing, setPrinting] = useState<AdminStation | null>(null);
  const [busy, setBusy] = useState(false);

  /**
   * Runs one station write. A failure is NOT swallowed here: it rejects into
   * the confirmation that asked for it, which shows the server's message.
   * (It used to reject into a `void`, so a failed "turn off" looked like one
   * that worked.)
   */
  const act = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    try {
      await run();
      query.reload();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {settingUp === null ? null : (
        <TabletSetupWizard
          station={settingUp}
          onFinished={() => {
            setSettingUp(null);
            query.reload();
          }}
          onCancel={() => setSettingUp(null)}
        />
      )}
      {printing === null ? null : (
        <SetupCardModal station={printing} onClose={() => setPrinting(null)} />
      )}

      <DataState
        loading={query.loading}
        error={query.error}
        empty={(query.data?.length ?? 0) === 0}
        emptyTitle="No stations yet"
        emptyHint="A station is the screen members scan. The seed creates one on first deploy."
        onRetry={query.reload}
      >
        <div style={{ display: 'grid', gap: 16 }}>
          {query.data?.map((station) => (
            <Card key={station.id}>
              <CardHead
                title={station.name}
                action={
                  <Badge tone={station.isActive ? 'ok' : 'danger'}>
                    {station.isActive ? 'Active' : 'Off'}
                  </Badge>
                }
              />

              <div
                style={{
                  display: 'flex',
                  gap: 22,
                  flexWrap: 'wrap',
                  fontSize: 13,
                  color: 'var(--p-ink2)',
                }}
              >
                <span>
                  Code <strong className="p-num">{station.code}</strong>
                  <div className="a-person-sub">printed on the label under the screen</div>
                </span>
                <span>
                  Last showed a code{' '}
                  <strong>
                    {station.lastTokenIssuedAt === null
                      ? 'never'
                      : gymDateTime(station.lastTokenIssuedAt)}
                  </strong>
                </span>
                <span>
                  Check-ins here <strong className="p-num">{station.checkInCount}</strong>
                </span>
              </div>

              {/* ── Primary action: open the live display ── */}
              <div
                style={{
                  marginTop: 14,
                  padding: '12px 16px',
                  borderRadius: 10,
                  border: '1px solid var(--p-border-2)',
                  background: 'var(--p-paper2)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--p-ink)' }}>
                    Rotating QR display
                  </div>
                  <div className="a-person-sub" style={{ marginTop: 2 }}>
                    Open this on the front-desk tablet. Members scan it to check in.
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <a
                    href="/desk/station"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="p-btn p-btn-gold p-btn-sm"
                  >
                    Open live QR ↗
                  </a>
                  <button
                    type="button"
                    className="p-btn p-btn-ghost p-btn-sm"
                    onClick={() => setPrinting(station)}
                  >
                    Print setup card
                  </button>
                </div>
              </div>

              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                <button
                  type="button"
                  className="p-btn p-btn-gold p-btn-sm"
                  disabled={busy}
                  onClick={() => setSettingUp(station)}
                >
                  Set up a tablet
                </button>

                <DisconnectAllButton
                  busy={busy}
                  stationName={station.name}
                  onConfirm={() =>
                    act(() => adminApi.updateStation(station.id, { bumpTokenEpoch: true }))
                  }
                />

                <ConfirmButton
                  busy={busy}
                  label={station.isActive ? 'Turn this screen off' : 'Turn this screen back on'}
                  title={
                    station.isActive
                      ? `Turn ${station.name} off?`
                      : `Turn ${station.name} back on?`
                  }
                  question={
                    station.isActive
                      ? 'Members cannot scan here. Staff can still check people in at the desk.'
                      : 'Members can scan here again straight away.'
                  }
                  confirmLabel={station.isActive ? 'Turn it off' : 'Turn it back on'}
                  cancelLabel={station.isActive ? 'Keep it on' : 'Leave it off'}
                  danger={station.isActive}
                  onConfirm={() =>
                    act(() => adminApi.updateStation(station.id, { isActive: !station.isActive }))
                  }
                />
              </div>

              <div style={{ marginTop: 18 }}>
                <div className="p-card-title" style={{ marginBottom: 8 }}>
                  Tablets
                </div>
                {station.credentials.length === 0 ? (
                  <span className="p-muted">
                    No tablet is connected yet. Press “Set up a tablet” above — it takes about a minute.
                  </span>
                ) : (
                  <div className="a-scroll">
                    <table className="p-table" style={{ minWidth: 0 }}>
                      <thead>
                        <tr>
                          <th>Label</th>
                          <th>Last seen</th>
                          <th>Provisioned</th>
                          <th>State</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {station.credentials.map((credential) => (
                          <tr key={credential.id}>
                            <td>{credential.label}</td>
                            <td className="p-muted">
                              {credential.lastUsedAt === null
                                ? 'never'
                                : gymDateTime(credential.lastUsedAt)}
                            </td>
                            <td className="p-muted">{gymDateTime(credential.createdAt)}</td>
                            <td>
                              <Badge tone={credential.isActive ? 'ok' : 'neutral'}>
                                {credential.isActive ? 'Active' : 'Revoked'}
                              </Badge>
                            </td>
                            <td>
                              {credential.isActive ? (
                                <ConfirmButton
                                  busy={busy}
                                  label="Disconnect"
                                  title={`Disconnect “${credential.label}”?`}
                                  question={`“${credential.label}” stops working straight away. You can set it up again any time.`}
                                  confirmLabel="Disconnect it"
                                  cancelLabel="Keep it connected"
                                  danger
                                  onConfirm={() =>
                                    act(() => adminApi.revokeStationCredential(credential.id))
                                  }
                                />
                              ) : null}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      </DataState>
    </div>
  );
}


/**
 * Printable setup card for a station tablet.
 *
 * Shows a real QR code that navigates the tablet browser to /desk/station
 * so staff can scan-to-open on setup, plus the station code and setup steps.
 *
 * The QR here encodes the URL — it is NOT a check-in token. The check-in
 * tokens are generated live at /desk/station and rotate every 30 seconds.
 */
function SetupCardModal({ station, onClose }: { station: AdminStation; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [url, setUrl] = useState('');
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Build the absolute URL to the station display page
    const stationUrl =
      typeof window !== 'undefined'
        ? `${window.location.origin}/desk/station`
        : '/desk/station';
    setUrl(stationUrl);

    if (canvasRef.current) {
      void QRCode.toCanvas(canvasRef.current, stationUrl, {
        width: 220,
        margin: 2,
        color: { dark: '#000000', light: '#ffffff' },
        errorCorrectionLevel: 'M',
      });
    }
  }, []);

  const handleDownload = async (): Promise<void> => {
    setDownloading(true);
    setError(null);
    try {
      await downloadSetupCardPdf({
        stationName: station.name,
        stationCode: station.code,
        pairingUrl: url,
        code: station.code,
        expiresAt: new Date().toISOString(),
      });
    } catch {
      setError('Could not generate the PDF. Try again.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Modal
      open
      title={`Setup card — ${station.name}`}
      subtitle="Scan to open the station display on the tablet, or type the URL manually."
      onClose={onClose}
      busy={downloading}
      footer={
        <>
          <button
            type="button"
            className="p-btn p-btn-ghost p-btn-sm"
            onClick={onClose}
            disabled={downloading}
          >
            Close
          </button>
          <button
            type="button"
            className="p-btn p-btn-gold p-btn-sm"
            onClick={() => void handleDownload()}
            disabled={downloading}
          >
            {downloading ? 'Generating…' : 'Download PDF'}
          </button>
        </>
      }
    >
      <div style={{ display: 'flex', gap: 28, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* QR + URL */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 10,
            flex: 'none',
            maxWidth: '100%',
            // Centres the QR on its own line once the instructions wrap below it.
            marginInline: 'auto',
          }}
        >
          <canvas
            ref={canvasRef}
            style={{
              display: 'block',
              border: '3px solid #000',
              borderRadius: 8,
              background: '#fff',
            }}
          />
          <div
            style={{
              fontSize: 11,
              color: 'var(--p-ink3)',
              fontFamily: 'ui-monospace, monospace',
              wordBreak: 'break-all',
              textAlign: 'center',
            }}
          >
            {url}
          </div>
        </div>

        {/* Instructions */}
        <div style={{ flex: '1 1 220px', minWidth: 0 }}>
          <div
            style={{
              fontFamily: 'var(--font-heading)',
              fontSize: 22,
              fontWeight: 800,
              letterSpacing: '-0.01em',
              color: 'var(--p-ink)',
              marginBottom: 4,
            }}
          >
            {station.name.toUpperCase()}
          </div>
          <div
            style={{
              fontSize: 13,
              color: 'var(--p-ink3)',
              fontFamily: 'ui-monospace, monospace',
              marginBottom: 18,
            }}
          >
            Station code: <strong style={{ color: 'var(--p-ink)' }}>{station.code}</strong>
          </div>

          <ol
            style={{
              margin: 0,
              paddingLeft: 18,
              display: 'grid',
              gap: 10,
              fontSize: 14,
              lineHeight: 1.5,
              color: 'var(--p-ink2)',
            }}
          >
            <li>
              On the front-desk tablet, open the camera and scan the QR code, or navigate to the
              URL below it.
            </li>
            <li>
              When prompted, paste the <strong style={{ color: 'var(--p-ink)' }}>tablet key</strong>{' '}
              from Admin → Stations → Set up a tablet.
            </li>
            <li>
              The rotating check-in QR will appear. Members scan this with their phone to check in
              — it changes every 30 seconds.
            </li>
            <li>
              Keep this tablet plugged in and the screen awake. The display manages its own
              wake-lock.
            </li>
          </ol>

          <div
            style={{
              marginTop: 18,
              padding: '10px 12px',
              borderRadius: 8,
              background: 'var(--p-warn-bg)',
              border: '1px solid rgba(201,146,42,.3)',
              fontSize: 12,
              color: 'var(--p-ink2)',
              lineHeight: 1.5,
            }}
          >
            <strong>Note:</strong> The QR on this card opens the setup page. The actual rotating
            check-in codes are generated live — they are not printable.
          </div>
        </div>
      </div>

      <ModalError message={error} />
    </Modal>
  );
}

/**
 * A station action that asks first, never through `window.confirm`.
 *
 * A browser dialog is modal, unstyled, and looks identical whether it is about
 * a stolen tablet or a closed entrance — so people learn to dismiss it without
 * reading. The console's `ConfirmDialog` names the screen, writes the real
 * consequence out and puts the verb on the button, which makes the second
 * click mean something. A failed write stays in the dialog with the server's
 * reason instead of disappearing.
 */
function ConfirmButton({
  busy,
  label,
  title,
  question,
  confirmLabel,
  cancelLabel,
  danger = false,
  onConfirm,
}: {
  busy: boolean;
  label: string;
  title: string;
  question: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const [asking, setAsking] = useState(false);
  const confirm = useConfirmAction();

  const close = (): void => {
    if (confirm.busy) return;
    confirm.reset();
    setAsking(false);
  };

  return (
    <>
      <button
        type="button"
        className="p-btn p-btn-ghost p-btn-sm"
        disabled={busy}
        onClick={() => setAsking(true)}
      >
        {label}
      </button>

      <ConfirmDialog
        open={asking}
        title={title}
        consequence={question}
        confirmLabel={confirmLabel}
        cancelLabel={cancelLabel}
        tone={danger ? 'danger' : 'default'}
        busy={confirm.busy}
        error={confirm.error}
        onConfirm={() => {
          void confirm.run(onConfirm).then((ok) => {
            if (!ok) return;
            confirm.reset();
            setAsking(false);
          });
        }}
        onClose={close}
      />
    </>
  );
}

/**
 * The panic button, named for the emergency rather than the mechanism.
 *
 * It used to read "New key version", which describes what a database column
 * does and not what the person is trying to achieve. Somebody whose tablet has
 * just been stolen is not looking for a key version.
 */
function DisconnectAllButton({
  busy,
  stationName,
  onConfirm,
}: {
  busy: boolean;
  stationName: string;
  onConfirm: () => Promise<unknown>;
}) {
  return (
    <ConfirmButton
      busy={busy}
      label="A tablet was lost or stolen"
      title={`Disconnect every tablet on ${stationName}?`}
      question="Every tablet on this screen stops working within 30 seconds. You will set them up again — about a minute each."
      confirmLabel="Disconnect them all"
      cancelLabel="Keep them connected"
      danger
      onConfirm={onConfirm}
    />
  );
}
