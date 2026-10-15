'use client';

import { useState } from 'react';
import { roleLabel, type IssuedStaffInvitation } from '@got/shared';
import { Card, CardHead } from '@/components/portal/ui';

/**
 * The invitation link, shown ONCE.
 *
 * The server keeps only a hash of the token, so this is the only moment the
 * link exists anywhere the console can read it. That is said plainly, with a
 * copy button — and whether the email went, because "sent" and "not sent"
 * mean different next steps for the admin.
 */
export function IssuedLinkCard({
  issued,
  onDismiss,
}: {
  issued: IssuedStaffInvitation;
  onDismiss: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const { invitation, link, emailSent } = issued;

  return (
    <Card style={{ borderColor: 'var(--gold)' }}>
      <CardHead
        title={`Invitation ready — ${invitation.email} as ${roleLabel(invitation.role)}`}
        action={
          <button type="button" className="p-btn p-btn-ghost p-btn-sm" onClick={onDismiss}>
            Done
          </button>
        }
      />
      <p style={{ margin: '0 0 12px', fontSize: 14, lineHeight: 1.55, color: 'var(--p-ink2)' }}>
        {emailSent
          ? `We emailed this link to ${invitation.email}. You can also send it yourself.`
          : `The email could not be sent from here, so send ${invitation.email} this link yourself.`}{' '}
        It works for 7 days, and this is the only time it is shown — to get a new one, use Resend.
      </p>
      <div className="a-secret" aria-label="Invitation link">
        {link}
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button
          type="button"
          className="p-btn p-btn-gold p-btn-sm"
          onClick={() => {
            void navigator.clipboard?.writeText(link).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy link'}
        </button>
      </div>
    </Card>
  );
}
