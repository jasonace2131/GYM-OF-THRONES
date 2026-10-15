'use client';

import { useState } from 'react';
import { Modal, ModalError } from '@/components/admin/Modal';
import { adminApi, peso, type AdminPlan } from '@/lib/adminApi';
import { ConfirmDialog } from './ConfirmDialog';

/**
 * Create or edit a plan — the screen behind "I can't change my prices".
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE API FOR THIS HAS EXISTED ALL ALONG.
 *
 * `POST /admin/plans`, `PATCH /admin/plans/:id` and `POST /admin/plans/:id/
 * archive` are implemented, validated and gated on `plan.manage`. What was
 * missing was any way to reach them: `adminApi` exposed only `plans()`, and
 * Settings rendered a read-only table. The conclusion was that the system
 * could not change prices; in fact nothing could ask it to.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `code` and `kind` are editable on create and FROZEN on edit. `code` is
 * snapshotted onto `Membership.planCode` and `Payment.planCode` at sale time,
 * so changing it would orphan every historical row naming it — the server
 * omits it from `UpdatePlanDto` entirely, so sending one is a 400 rather than
 * a silent no-op.
 */
export function PlanEditorModal({
  open,
  existing,
  onClose,
  onSaved,
}: {
  open: boolean;
  /** `null` creates. */
  existing: AdminPlan | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const isEdit = existing !== null;

  const [code, setCode] = useState(existing?.code ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [kind, setKind] = useState<'TERM' | 'WALK_IN'>(
    (existing?.kind as 'TERM' | 'WALK_IN') ?? 'TERM',
  );
  // Pesos in the input, centavos on the wire. Staff think in pesos and the
  // column is an integer; converting once at this boundary is what keeps a
  // float from ever reaching the money column.
  const [pesos, setPesos] = useState(existing === null ? '' : String(existing.priceCentavos / 100));
  const [termMonths, setTermMonths] = useState(
    existing === null || existing.termMonths === null ? '' : String(existing.termMonths),
  );
  const [graceDays, setGraceDays] = useState(String(existing?.graceDays ?? 3));
  const [guestPasses, setGuestPasses] = useState(String(existing?.guestPassesPerTerm ?? 0));
  const [freezable, setFreezable] = useState(existing?.freezable ?? false);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A price change moves every future sale, so saving is confirmed.
  const [confirming, setConfirming] = useState(false);

  const priceCentavos = Math.round(Number(pesos) * 100);
  const validPrice = pesos.trim() !== '' && Number.isFinite(priceCentavos) && priceCentavos >= 0;
  // `Plan_term_matches_kind`: a TERM plan needs 1–60 months, a WALK_IN must
  // have none and cannot be freezable. Mirrored here so staff see the rule
  // rather than a 422 surfacing from a database constraint.
  const validTerm = kind === 'WALK_IN' || (Number(termMonths) >= 1 && Number(termMonths) <= 60);
  const validCode = isEdit || /^[A-Z][A-Z0-9_]{1,23}$/.test(code);
  const canSave = name.trim() !== '' && validPrice && validTerm && validCode;

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const shared = {
        name: name.trim(),
        description: description.trim() === '' ? undefined : description.trim(),
        priceCentavos,
        termMonths: kind === 'WALK_IN' ? null : Number(termMonths),
        freezable: kind === 'WALK_IN' ? false : freezable,
        guestPassesPerTerm: Number(guestPasses),
        graceDays: Number(graceDays),
      };

      if (isEdit) await adminApi.updatePlan(existing.id, shared);
      else await adminApi.createPlan({ ...shared, code: code.trim(), kind });

      onSaved();
    } catch (caught) {
      setBusy(false);
      setError(caught instanceof Error ? caught.message : 'That did not save.');
    }
  };

  return (
    <>
      <Modal
        open={open && !confirming}
        title={isEdit ? `Edit ${existing.name}` : 'New plan'}
        subtitle={
          isEdit
            ? 'Changes apply to FUTURE sales only. Memberships already sold keep the price and term they were sold at.'
            : 'A plan can be archived later but never deleted — every payment made on it names it.'
        }
        onClose={onClose}
        busy={busy}
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={onClose} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => setConfirming(true)}
              disabled={!canSave || busy}
            >
              {isEdit ? 'Save changes' : 'Create plan'}
            </button>
          </>
        }
      >
        <ModalError message={error} />

        <div className="a-field">
          <label className="a-field-label" htmlFor="plan-code">
            Code
          </label>
          <input
            id="plan-code"
            className="a-input"
            value={code}
            autoComplete="off"
            onChange={(event) => setCode(event.target.value.toUpperCase())}
            disabled={isEdit || busy}
            placeholder="MONTHLY"
          />
          <p className="a-field-hint">
            {isEdit
              ? 'Cannot be changed — every past sale references it.'
              : 'Capitals, digits and underscores. Permanent once created.'}
          </p>
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="plan-kind">
            Kind
          </label>
          <select
            id="plan-kind"
            className="a-input"
            value={kind}
            onChange={(event) => setKind(event.target.value as 'TERM' | 'WALK_IN')}
            disabled={isEdit || busy}
          >
            <option value="TERM">Term membership</option>
            <option value="WALK_IN">Walk-in day pass</option>
          </select>
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="plan-name">
            Name
          </label>
          <input
            id="plan-name"
            className="a-input"
            value={name}
            autoComplete="off"
            autoFocus
            onChange={(event) => setName(event.target.value)}
            disabled={busy}
            placeholder="Monthly"
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="plan-desc">
            Description <span className="a-field-opt">optional</span>
          </label>
          <input
            id="plan-desc"
            className="a-input"
            value={description}
            autoComplete="off"
            onChange={(event) => setDescription(event.target.value)}
            disabled={busy}
            placeholder="One month from your join date."
          />
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="plan-price">
            Price (₱)
          </label>
          <input
            id="plan-price"
            className="a-input"
            type="number"
            inputMode="decimal"
            min={0}
            step="0.01"
            value={pesos}
            onChange={(event) => setPesos(event.target.value)}
            disabled={busy}
          />
          <p className="a-field-hint">
            Stored as {validPrice ? priceCentavos.toLocaleString() : '—'} centavos.
            {isEdit ? ' Members already on this plan keep the price they paid.' : ''}
          </p>
        </div>

        {kind === 'TERM' && (
          <div className="a-field">
            <label className="a-field-label" htmlFor="plan-term">
              Term (months)
            </label>
            <input
              id="plan-term"
              className="a-input"
              type="number"
              min={1}
              max={60}
              value={termMonths}
              onChange={(event) => setTermMonths(event.target.value)}
              disabled={busy}
            />
          </div>
        )}

        <div className="a-field">
          <label className="a-field-label" htmlFor="plan-grace">
            Grace days
          </label>
          <input
            id="plan-grace"
            className="a-input"
            type="number"
            min={0}
            max={14}
            value={graceDays}
            onChange={(event) => setGraceDays(event.target.value)}
            disabled={busy}
          />
          <p className="a-field-hint">
            How long a lapsed member may still be admitted while renewing. Maximum 14.
          </p>
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="plan-passes">
            Guest passes per term
          </label>
          <input
            id="plan-passes"
            className="a-input"
            type="number"
            min={0}
            max={12}
            value={guestPasses}
            onChange={(event) => setGuestPasses(event.target.value)}
            disabled={busy}
          />
        </div>

        {kind === 'TERM' && (
          <div className="a-field">
            <label className="a-field-label" htmlFor="plan-freezable">
              <input
                id="plan-freezable"
                type="checkbox"
                checked={freezable}
                onChange={(event) => setFreezable(event.target.checked)}
                disabled={busy}
                style={{ marginRight: 8, width: 15, height: 15, accentColor: 'var(--gold)' }}
              />
              Members may freeze this plan
            </label>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={
          isEdit
            ? `Save changes to ${existing.name}?`
            : `Create “${name.trim()}” at ${validPrice ? peso(priceCentavos) : '—'}?`
        }
        consequence={
          isEdit
            ? 'Applies to future sales only. Memberships already sold keep the price and term they were sold at.'
            : 'It appears on the sale screens straight away. A plan can be archived later but never deleted.'
        }
        confirmLabel={isEdit ? 'Save changes' : 'Create plan'}
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void submit()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      >
        <ul className="a-confirm-facts">
          <li>
            <strong>{validPrice ? peso(priceCentavos, { decimals: true }) : '—'}</strong>
            {kind === 'WALK_IN' ? ' · walk-in day pass' : ` · ${termMonths} month term`}
          </li>
          <li>
            Grace {graceDays} day{graceDays === '1' ? '' : 's'} · {guestPasses} guest pass
            {guestPasses === '1' ? '' : 'es'} per term
            {kind === 'TERM' ? (freezable ? ' · freezable' : ' · not freezable') : ''}
          </li>
        </ul>
      </ConfirmDialog>
    </>
  );
}
