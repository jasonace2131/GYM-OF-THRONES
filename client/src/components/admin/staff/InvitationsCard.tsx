'use client';

import { useState } from 'react';
import { roleLabel, type IssuedStaffInvitation, type StaffInvitationView } from '@got/shared';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { ConfirmDialog, useConfirmAction } from '@/components/admin/actions/ConfirmDialog';
import { civilDate } from '@/lib/adminApi';
import { staffApi } from '@/lib/staffApi';
import {
  invitationActions,
  invitationBadge,
  invitationTimeline,
  splitInvitations,
} from '@/lib/staff/invitations';

type Pending = { kind: 'resend' | 'revoke'; invitation: StaffInvitationView } | null;

/**
 * Invitations: the open ones first (something to do), then the last month's
 * history (nothing to do). Resend and Withdraw each go through the one
 * console confirmation; both are shown only when this caller could give the
 * invitation's role (`invitationActions`).
 */
export function InvitationsCard({
  invitations,
  callerRole,
  onChanged,
  onIssued,
}: {
  invitations: StaffInvitationView[];
  callerRole: string | null;
  onChanged: () => void;
  onIssued: (issued: IssuedStaffInvitation) => void;
}) {
  const [pending, setPending] = useState<Pending>(null);
  const { busy, error, run, reset } = useConfirmAction();
  const { open, recent } = splitInvitations(invitations);
  const now = new Date();

  const close = (): void => {
    if (busy) return;
    reset();
    setPending(null);
  };

  const confirm = (): void => {
    if (pending === null) return;
    const { kind, invitation } = pending;
    void run(async () => {
      if (kind === 'resend') {
        onIssued(await staffApi.resendInvitation(invitation.id));
      } else {
        await staffApi.revokeInvitation(invitation.id);
      }
    }).then((ok) => {
      if (!ok) return;
      reset();
      setPending(null);
      onChanged();
    });
  };

  const rows = (list: StaffInvitationView[], withActions: boolean) => (
    <div className="a-scroll">
      <table className="p-table" data-stack>
        <thead>
          <tr>
            <th>Invited</th>
            <th>Role</th>
            <th>Status</th>
            <th>Sent by</th>
            {withActions ? <th /> : null}
          </tr>
        </thead>
        <tbody>
          {list.map((invitation) => {
            const badge = invitationBadge(invitation.status);
            const actions = invitationActions(invitation, callerRole);
            return (
              <tr key={invitation.id}>
                <td data-card="title" className="a-wrap">
                  <strong>{invitation.email}</strong>
                  <div className="a-person-sub">{invitationTimeline(invitation, now)}</div>
                </td>
                <td data-label="Role">{roleLabel(invitation.role)}</td>
                <td data-label="Status" data-card="meta">
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </td>
                <td className="p-muted" data-label="Sent by">
                  {invitation.invitedBy.name}
                  <div className="a-person-sub">{civilDate(invitation.createdAt.slice(0, 10))}</div>
                </td>
                {withActions ? (
                  <td className="a-cell-actions" data-card="actions">
                    <span className="a-btn-row">
                    {actions.resend ? (
                      <button
                        type="button"
                        className="p-btn p-btn-ghost p-btn-sm"
                        onClick={() => setPending({ kind: 'resend', invitation })}
                      >
                        Resend
                      </button>
                    ) : null}
                    {actions.revoke ? (
                      <button
                        type="button"
                        className="p-btn p-btn-ghost p-btn-sm"
                        onClick={() => setPending({ kind: 'revoke', invitation })}
                      >
                        Withdraw
                      </button>
                    ) : null}
                    </span>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <>
      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead title="Invitations" />
        </div>
        {open.length === 0 ? (
          <p className="p-muted" style={{ margin: 0, padding: '0 18px 18px', fontSize: 14 }}>
            No invitations waiting. Invite someone above and it appears here until they accept.
          </p>
        ) : (
          rows(open, true)
        )}
        {recent.length === 0 ? null : (
          <details style={{ padding: '6px 18px 16px' }}>
            <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--p-ink2)' }}>
              Last 30 days ({recent.length})
            </summary>
            <div style={{ marginTop: 10 }}>{rows(recent, false)}</div>
          </details>
        )}
        <p className="a-field-hint" style={{ margin: 0, padding: '0 18px 16px' }}>
          A link is shown only once, when it is issued. Resend gives a fresh link — by email and to
          copy — and the old one stops working.
        </p>
      </Card>

      <ConfirmDialog
        open={pending?.kind === 'resend'}
        title={`Resend ${pending?.invitation.email ?? ''}'s invitation?`}
        consequence="They get a new link, valid for 7 days, and the link they have now stops working."
        confirmLabel="Resend invitation"
        cancelLabel="Don't resend"
        busy={busy}
        error={error}
        onConfirm={confirm}
        onClose={close}
      />
      <ConfirmDialog
        open={pending?.kind === 'revoke'}
        title={`Withdraw ${pending?.invitation.email ?? ''}'s invitation?`}
        consequence="Their link stops working straight away. Nothing changes for anybody who already has access."
        confirmLabel="Withdraw invitation"
        cancelLabel="Keep invitation"
        tone="danger"
        busy={busy}
        error={error}
        onConfirm={confirm}
        onClose={close}
      />
    </>
  );
}
