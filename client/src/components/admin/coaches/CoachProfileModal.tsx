'use client';

import { useState } from 'react';
import { COACH_PROFILE_LIMITS, type CoachProfileView } from '@got/shared';
import { staffApi } from '@/lib/staffApi';
import { confirmErrorMessage } from '@/lib/confirm';
import {
  draftFromProfile,
  draftProblem,
  draftToBody,
  parseSpecializations,
  type ProfileDraft,
} from '@/lib/coaches/profileDraft';
import { Modal, ModalError } from '../Modal';
import { ConfirmDialog } from '../actions/ConfirmDialog';

/**
 * Edit what members read about a coach — `coach.profile.update`.
 *
 * Specializations are one comma-separated line (five short tags do not need
 * a chip editor); the counter under each field counts what the DATABASE will
 * count, so Save is never offered on a profile the server refuses. Confirmed
 * like every other console write, and audited as COACH_PROFILE_UPDATED.
 */
export function CoachProfileModal({
  open,
  coach,
  profile,
  onClose,
  onSaved,
}: {
  open: boolean;
  coach: { userId: string; firstName: string; lastName: string };
  profile: CoachProfileView | undefined;
  onClose: () => void;
  onSaved: (saved: CoachProfileView) => void;
}) {
  const [draft, setDraft] = useState<ProfileDraft>(() => draftFromProfile(profile));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const name = `${coach.firstName} ${coach.lastName}`.trim();
  const problem = draftProblem(draft);
  const tags = parseSpecializations(draft.specializations);

  const close = (): void => {
    if (busy) return;
    setError(null);
    setConfirming(false);
    onClose();
  };

  const save = async (): Promise<void> => {
    if (problem !== null) return;
    setBusy(true);
    setError(null);
    try {
      const saved = await staffApi.updateCoachProfile(coach.userId, draftToBody(draft));
      onSaved(saved);
      setBusy(false);
      setConfirming(false);
      onClose();
    } catch (caught) {
      setError(confirmErrorMessage(caught));
      setBusy(false);
    }
  };

  return (
    <>
      <Modal
        open={open && !confirming}
        onClose={close}
        busy={busy}
        title={`${name}'s profile`}
        subtitle="Members see this on My Coach, and staff see it when assigning a coach."
        footer={
          <>
            <button type="button" className="p-btn p-btn-ghost" onClick={close} disabled={busy}>
              Cancel
            </button>
            <button
              type="button"
              className="p-btn p-btn-gold"
              onClick={() => setConfirming(true)}
              disabled={busy || problem !== null}
            >
              Save profile
            </button>
          </>
        }
      >
        <div className="a-field">
          <label className="a-field-label" htmlFor="coach-profile-tags">
            Specializations <span className="a-field-opt">comma-separated</span>
          </label>
          <input
            id="coach-profile-tags"
            className="a-input"
            value={draft.specializations}
            autoComplete="off"
            autoFocus
            placeholder="Strength, Mobility, Boxing"
            onChange={(event) => setDraft({ ...draft, specializations: event.target.value })}
          />
          <p className="a-field-hint">
            {tags.length}/{COACH_PROFILE_LIMITS.specializations} — each up to{' '}
            {COACH_PROFILE_LIMITS.specializationLength} characters.
          </p>
        </div>

        <div className="a-field">
          <label className="a-field-label" htmlFor="coach-profile-bio">
            Bio <span className="a-field-opt">optional</span>
          </label>
          <textarea
            id="coach-profile-bio"
            className="a-textarea"
            rows={5}
            value={draft.bio}
            maxLength={COACH_PROFILE_LIMITS.bioLength + 50}
            placeholder="Background, certifications, what a session with them is like."
            onChange={(event) => setDraft({ ...draft, bio: event.target.value })}
          />
          <p className="a-field-hint">
            {draft.bio.trim().length}/{COACH_PROFILE_LIMITS.bioLength} characters.
          </p>
        </div>

        <ModalError message={problem ?? error} />
      </Modal>

      <ConfirmDialog
        open={open && confirming}
        title={`Save ${name}'s profile?`}
        consequence="Members assigned to them see the new specializations and bio straight away."
        confirmLabel="Save profile"
        cancelLabel="Keep editing"
        busy={busy}
        error={error}
        onConfirm={() => void save()}
        onClose={() => {
          if (!busy) setConfirming(false);
        }}
      />
    </>
  );
}
