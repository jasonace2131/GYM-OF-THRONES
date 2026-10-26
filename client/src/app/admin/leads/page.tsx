'use client';

import { useCallback, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { NewMemberDrawer } from '@/components/admin/NewMemberDrawer';
import type { NewMemberSeed } from '@/lib/memberSeed';
import { adminApi, type Lead, type LeadStatus } from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { PERMISSIONS } from '@got/shared';
import { usePermission } from '@/components/rbac/MeProvider';
import { ConfirmDialog, useConfirmAction } from '@/components/admin/actions/ConfirmDialog';

const STATUSES: LeadStatus[] = ['NEW', 'CONTACTED', 'CONVERTED', 'LOST'];

const TONE: Record<LeadStatus, 'ok' | 'warn' | 'neutral' | 'danger'> = {
  NEW: 'warn',
  CONTACTED: 'neutral',
  CONVERTED: 'ok',
  LOST: 'danger',
};

/** "3 days ago" reads faster than a date when the whole point is "how stale". */
function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86_400_000);
  if (days === 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return new Date(iso).toLocaleDateString('en-PH', { day: 'numeric', month: 'short' });
}

/**
 * Enquiries from people who have not joined.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * THE SCREEN THIS CRM DID NOT HAVE.
 *
 * Every other admin page describes a member. There was nowhere to put a
 * person who asked the price and left to think about it — which is most of
 * the people a gym talks to, and the whole reason a CRM exists rather than a
 * membership database.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Deliberately not a drawer-and-bulk-actions screen like Members. A lead has
 * four fields and one decision — did we call them, did they join — and a list
 * with inline status buttons is the right size for that. Add complexity when
 * the volume demands it, not before.
 */
export default function AdminLeadsPage() {
  const [filter, setFilter] = useState<LeadStatus | 'ALL'>('NEW');

  const leads = useAdminQuery(
    useCallback(() => adminApi.leads(filter === 'ALL' ? undefined : filter), [filter]),
    `leads:${filter}`,
    // Enquiries arrive while staff are on other screens; a stale list is how
    // somebody waits two days for a reply nobody knew they were owed.
    { pollMs: 120_000 },
  );

  const canWork = usePermission(PERMISSIONS.MEMBER_UPDATE);
  // Convert creates the account, so it needs the stronger key — same gate as
  // "+ New member" on the Members screen.
  const canConvert = usePermission(PERMISSIONS.MEMBER_CREATE);
  const router = useRouter();

  const [saving, setSaving] = useState<string | null>(null);
  const [converting, setConverting] = useState<NewMemberSeed | null>(null);
  // A status move waiting on its confirmation.
  const [moving, setMoving] = useState<{ lead: Lead; status: LeadStatus } | null>(null);
  const moveConfirm = useConfirmAction();

  /** Lead name is one string; the account wants two. Split on the first space. */
  const seedFrom = (lead: Lead): NewMemberSeed => {
    const name = lead.name.trim();
    const space = name.indexOf(' ');
    return {
      firstName: space === -1 ? name : name.slice(0, space),
      lastName: space === -1 ? '' : name.slice(space + 1),
      email: lead.email ?? '',
      phone: lead.phone ?? '',
      leadId: lead.id,
    };
  };

  /** Opens the confirmation; the write happens in `confirmMove`. */
  const move = (lead: Lead, status: LeadStatus): void => {
    moveConfirm.reset();
    setMoving({ lead, status });
  };

  const confirmMove = (): void => {
    if (moving === null) return;
    const { lead, status } = moving;
    setSaving(lead.id);
    void moveConfirm
      .run(() => adminApi.updateLead(lead.id, { status }))
      .then((ok) => {
        setSaving(null);
        if (!ok) return;
        setMoving(null);
        leads.reload();
      });
  };

  const newCount = (leads.data ?? []).filter((l) => l.status === 'NEW').length;

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead
            title={filter === 'NEW' && newCount > 0 ? `Leads · ${newCount} new` : 'Leads'}
            action={
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {(['ALL', ...STATUSES] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    className={`p-btn p-btn-sm ${filter === option ? 'p-btn-gold' : 'p-btn-ghost'}`}
                    onClick={() => setFilter(option)}
                  >
                    {option === 'ALL' ? 'All' : option.charAt(0) + option.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            }
          />
        </div>

        <DataState
          loading={leads.loading}
          error={leads.error}
          empty={(leads.data?.length ?? 0) === 0}
          emptyTitle={filter === 'NEW' ? 'No new enquiries' : 'Nothing here'}
          emptyHint="Messages sent through the website's contact form arrive here."
          onRetry={leads.reload}
        >
          <div className="a-scroll">
            <table className="p-table" data-stack>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Contact</th>
                  <th>Message</th>
                  <th>Received</th>
                  <th>Status</th>
                  {canWork && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {(leads.data ?? []).map((lead) => (
                  <tr key={lead.id}>
                    <td data-card="title">
                      <strong>{lead.name}</strong>
                      {!lead.emailSent && (
                        <div
                          className="p-muted"
                          style={{ fontSize: 11 }}
                          title="Saved here, but the notification email did not send."
                        >
                          not emailed
                        </div>
                      )}
                    </td>
                    <td data-label="Contact" className="a-wrap">
                      {/* Both clickable. Staff reply from the phone at the
                          counter, so a number they have to retype is a number
                          that does not get called. */}
                      {lead.phone !== null && (
                        <div>
                          <a href={`tel:${lead.phone.replace(/\s/g, '')}`}>{lead.phone}</a>
                        </div>
                      )}
                      {lead.email !== null && (
                        <div style={{ fontSize: 12.5 }}>
                          <a href={`mailto:${lead.email}`}>{lead.email}</a>
                        </div>
                      )}
                    </td>
                    <td className="a-col-message" data-label="Message">
                      <span className="p-muted" style={{ fontSize: 13 }}>
                        {lead.message ?? '—'}
                      </span>
                    </td>
                    <td className="p-num" data-label="Received" data-card="meta">
                      {ago(lead.createdAt)}
                    </td>
                    <td data-label="Status" data-card="meta">
                      <Badge tone={TONE[lead.status]}>{lead.status}</Badge>
                    </td>
                    {canWork && (
                      <td data-card="actions">
                        <div className="a-btn-row a-btn-row--end">
                          {lead.status === 'NEW' && (
                            <button
                              type="button"
                              className="p-btn p-btn-ghost p-btn-sm"
                              disabled={saving === lead.id}
                              onClick={() => move(lead, 'CONTACTED')}
                            >
                              Mark contacted
                            </button>
                          )}
                          {lead.status !== 'CONVERTED' && lead.status !== 'LOST' && (
                            <>
                              {/* Creates the account prefilled from the lead
                                  and marks it CONVERTED with the link, in one
                                  server transaction. "Joined" stays for the
                                  person who registered themselves. */}
                              {canConvert && (
                                <button
                                  type="button"
                                  className="p-btn p-btn-gold p-btn-sm"
                                  disabled={saving === lead.id}
                                  onClick={() => setConverting(seedFrom(lead))}
                                >
                                  Convert
                                </button>
                              )}
                              <button
                                type="button"
                                className="p-btn p-btn-ghost p-btn-sm"
                                disabled={saving === lead.id}
                                onClick={() => move(lead, 'CONVERTED')}
                              >
                                Joined
                              </button>
                              <button
                                type="button"
                                className="p-btn p-btn-ghost p-btn-sm"
                                disabled={saving === lead.id}
                                onClick={() => move(lead, 'LOST')}
                              >
                                Lost
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </DataState>
      </Card>

      {converting !== null && (
        <NewMemberDrawer
          seed={converting}
          onClose={() => setConverting(null)}
          onCreated={() => leads.reload()}
          onOpenMember={() => router.push('/admin/members')}
        />
      )}

      <ConfirmDialog
        open={moving !== null}
        title={
          moving === null
            ? ''
            : moving.status === 'CONTACTED'
              ? `Mark ${moving.lead.name} as contacted?`
              : moving.status === 'CONVERTED'
                ? `Mark ${moving.lead.name} as joined?`
                : `Mark ${moving.lead.name} as lost?`
        }
        consequence={
          moving === null
            ? ''
            : moving.status === 'CONTACTED'
              ? 'The enquiry leaves the New list — nobody else needs to call them back.'
              : moving.status === 'CONVERTED'
                ? 'Records the enquiry as joined. No account is created — use Convert for that.'
                : 'Closes the enquiry. It leaves the open lists and stops counting as a lead to chase.'
        }
        confirmLabel={
          moving?.status === 'CONTACTED'
            ? 'Mark contacted'
            : moving?.status === 'CONVERTED'
              ? 'Mark joined'
              : 'Mark lost'
        }
        cancelLabel="Leave it as it is"
        busy={moveConfirm.busy}
        error={moveConfirm.error}
        onConfirm={confirmMove}
        onClose={() => {
          if (moveConfirm.busy) return;
          moveConfirm.reset();
          setMoving(null);
        }}
      />
    </div>
  );
}
