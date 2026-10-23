'use client';

import { useState } from 'react';
import { adminApi, peso } from '@/lib/adminApi';
import { ApiError } from '@/lib/api';
import { Modal, ModalError } from '../Modal';
import { ConfirmDialog } from './ConfirmDialog';
import { filterDecimalTyping, parsePesosToCentavos } from '@/lib/numberInput';

/**
 * The cash drawer, opened or closed.
 *
 * One modal for both because they are the same control in two states, and a
 * dashboard that showed "Open shift" and "Close shift" side by side would put
 * a disabled button on screen all day. Which one appears is decided by
 * `/shifts/current`, which is polled — so the button reflects the drawer even
 * when somebody else opened it at the other terminal.
 *
 * Money is integer centavos on the wire, everywhere. The input is in pesos
 * because that is what a person counts, and the conversion happens once, here,
 * on submit. `Math.round` rather than a truncation: 1234.56 pesos entered as a
 * float lands on 123455.99999 in binary, and a truncating cast would quietly
 * lose a centavo per shift.
 */
export function ShiftModal({
  open,
  onClose,
  onChanged,
  shift,
}: {
  open: boolean;
  onClose: () => void;
  onChanged: () => void;
  /** Null when no drawer is open — the modal then offers to open one. */
  shift: { id: string; openedAt: string } | null;
}) {
  const closing = shift !== null;
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const close = (): void => {
    setAmount('');
    setNote('');
    setError(null);
    setBusy(false);
    setConfirming(false);
    onClose();
  };

  // ₱0–₱100,000 with at most two decimals — the server's centavos ceiling.
  const parsed = parsePesosToCentavos(amount, 100_000);
  const centavos = parsed ?? 0;
  const valid = parsed !== null;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      if (shift === null) {
        await adminApi.openShift(centavos);
      } else {
        await adminApi.closeShift(shift.id, {
          countedCentavos: centavos,
          note: note.trim() === '' ? undefined : note.trim(),
        });
      }
      onChanged();
      close();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong.');
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={close}
        busy={busy}
        title={closing ? 'Close the drawer' : 'Open the drawer'}
        subtitle={
          closing
            ? 'Count the cash in the till and enter the total. The server works out the variance.'
            : 'Enter the opening float so the end-of-shift count has something to reconcile against.'
        }
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => setConfirming(true)}
              disabled={busy || !valid}
            >
              {closing ? 'Close shift' : 'Open shift'}
            </button>
          </>
        }
      >
        <div className="a-field">
          <label className="a-field-label" htmlFor="shift-amount">
            {closing ? 'Counted cash' : 'Opening float'}
          </label>
          <div className="a-money">
            <span aria-hidden>₱</span>
            <input
              id="shift-amount"
              className="a-input"
              value={amount}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              maxLength={9}
              onChange={(event) => setAmount(filterDecimalTyping(event.target.value, 2))}
            />
          </div>
          {valid && centavos > 0 && <p className="a-field-hint">{peso(centavos, { decimals: true })}</p>}
        </div>

        {closing && (
          <div className="a-field">
            <label className="a-field-label" htmlFor="shift-note">
              Note <span className="a-field-opt">required if the count does not balance</span>
            </label>
            <input
              id="shift-note"
              className="a-input"
              value={note}
              maxLength={500}
              autoComplete="off"
              placeholder="e.g. ₱20 short, gave change from own pocket"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
        )}

        <ModalError message={error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={
          closing
            ? `Close the drawer with ${peso(centavos, { decimals: true })} counted?`
            : `Open the drawer with a ${peso(centavos, { decimals: true })} float?`
        }
        consequence={
          closing
            ? 'Ends this shift. The server works out the variance against what the drawer should hold, and the count is kept as entered.'
            : 'Starts a shift. Every cash sale from now on is reconciled against this float when the drawer is closed.'
        }
        confirmLabel={closing ? 'Close shift' : 'Open shift'}
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        {closing && note.trim() !== '' ? (
          <ul className="a-confirm-facts">
            <li>Note: {note.trim()}</li>
          </ul>
        ) : null}
      </ConfirmDialog>
    </>
  );
}
