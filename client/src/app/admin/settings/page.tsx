'use client';

import { useCallback, useState } from 'react';
import Link from 'next/link';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { adminApi, peso, type AdminPlan } from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { PERMISSIONS } from '@got/shared';
import { usePermission } from '@/components/rbac/MeProvider';
import { PlanEditorModal } from '@/components/admin/actions/PlanEditorModal';
import { ConfirmActionModal } from '@/components/admin/actions/ConfirmActionModal';
import { OpeningHoursCard } from '@/components/admin/OpeningHoursCard';
import { AssistantSettingsCard } from '@/components/admin/AssistantSettingsCard';
import { EquipmentCard } from '@/components/admin/EquipmentCard';

/**
 * Settings.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * WHAT IS HERE, AND WHAT IS DELIBERATELY NOT.
 *
 * The mockup's settings screen carries staff accounts, per-weekday opening
 * hours, gym name and contact details, and four notification toggles. Almost
 * none of that has a source of truth today, and the rule this whole CRM
 * follows is that a control with nothing behind it is CUT rather than faked. A
 * toggle that does not toggle anything is worse than no toggle: somebody will
 * flip it, believe something changed, and be wrong for a month.
 *
 * So this screen shows the two things that ARE real — the plan catalogue and
 * the operating parameters — and names the rest honestly.
 *
 * THRESHOLDS ARE ENVIRONMENT, NOT DATABASE, and that is a deliberate choice
 * rather than an omission. The grace window, the freeze rules and the
 * attendance thresholds are validated at boot and crash the process if they
 * are wrong — which is exactly what you want from a value that decides
 * whether a member gets through a door. Making them editable from a browser
 * would move that failure from "the deploy stops" to "the front desk stops",
 * at 06:00, with nobody able to say why.
 *
 * OPENING HOURS ARE THE EXCEPTION, and the argument above is the reason the
 * exception is built the way it is. Hours change — holidays, a new weekend
 * schedule — often enough that a redeploy per change is not a real workflow,
 * and the cost of NOT making them editable was worse than theoretical: the
 * door shut at 22:00 while the ticker, the gallery caption and the footer all
 * advertised 11pm, so a member arriving at 22:30 was refused by a system
 * whose own website had told them to come.
 *
 * So `OpeningHours` OVERRIDES the environment rather than replacing it. No
 * row, an empty table, an unreachable database or a malformed time and the
 * gate falls back to `GYM_OPEN_TIME` / `GYM_CLOSE_TIME`, which still crash
 * the boot if they are wrong. Editable hours, with the old guarantee intact
 * underneath as a floor.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default function AdminSettingsPage() {
  // `includeInactive` so archived plans are visible and can be reasoned
  // about. Until now they were never fetched, which is what masked the
  // isArchived/isActive field mismatch — nothing archived ever arrived to
  // render the badge wrongly.
  const plans = useAdminQuery(
    useCallback(() => adminApi.plans({ includeInactive: true }), []),
    'plans',
  );

  const canManage = usePermission(PERMISSIONS.PLAN_MANAGE);
  // Its own key, not plan.manage: what the assistant is told is a separate
  // owner decision from the price list. The routes check the same key.
  const canConfigureAssistant = usePermission(PERMISSIONS.AI_ADMIN_CONFIGURE);
  // The two screens this page points to, each behind its own nav gate. The
  // front desk holds neither, and used to be linked straight into both.
  const canSeeCoaches = usePermission(PERMISSIONS.COACH_READ, { scope: 'ALL' });
  const canSeeStations = usePermission(PERMISSIONS.STATION_MANAGE);

  // `undefined` closed · `null` creating · a plan editing. Three states in one
  // variable so the modal cannot be open for a create and an edit at once.
  const [editing, setEditing] = useState<AdminPlan | null | undefined>(undefined);
  const [archiving, setArchiving] = useState<AdminPlan | null>(null);

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      {/* The editable hours — the one operating parameter that IS database,
          with the environment as its fallback floor. It was imported here and
          never mounted for a while, which made "customizable hours" invisible
          despite the whole server side existing; if this card is missing, that
          regression is back. */}
      <OpeningHoursCard canManage={canManage} />
      {canConfigureAssistant ? <AssistantSettingsCard /> : null}
      {/* What the AI planners may plan with — the same key as the assistant. */}
      {canConfigureAssistant ? <EquipmentCard /> : null}

      <Card padded={false}>
        <div style={{ padding: '18px 18px 0' }}>
          <CardHead
            title="Plans"
            action={
              canManage ? (
                <button
                  type="button"
                  className="p-btn p-btn-gold p-btn-sm"
                  onClick={() => setEditing(null)}
                >
                  New plan
                </button>
              ) : undefined
            }
          />
        </div>

        <DataState
          loading={plans.loading}
          error={plans.error}
          empty={(plans.data?.items.length ?? 0) === 0}
          emptyTitle="No plans in the catalogue"
          emptyHint="The seed loads the four starting plans."
          onRetry={plans.reload}
        >
          <div className="a-scroll">
            <table className="p-table" data-stack>
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Kind</th>
                  <th className="p-num">Price</th>
                  <th className="p-num">Term</th>
                  <th className="p-num">Grace</th>
                  <th>State</th>
                  {canManage && <th aria-label="Actions" />}
                </tr>
              </thead>
              <tbody>
                {plans.data?.items.map((plan) => (
                  <tr key={plan.id}>
                    {/* Not `.p-num` — this is an identifier (e.g. "BASIC-1M"),
                        not a number, and the `Code` header above it was never
                        marked numeric either. It had been right-aligning
                        against a left-aligned header. */}
                    <td data-label="Code" className="a-wrap">
                      {plan.code}
                    </td>
                    <td data-card="title">{plan.name}</td>
                    <td data-label="Kind">{plan.kind === 'WALK_IN' ? 'Walk-in' : 'Term'}</td>
                    {/* Integer centavos on the wire; the peso sign is rendered
                        here, never on the server. */}
                    <td className="p-num" data-card="value">
                      {peso(plan.priceCentavos)}
                    </td>
                    <td className="p-num" data-label="Term">
                      {plan.termMonths === null ? '—' : `${plan.termMonths} mo`}
                    </td>
                    <td className="p-num" data-label="Grace">
                      {plan.graceDays}d
                    </td>
                    <td data-label="State" data-card="meta">
                      <Badge tone={plan.isActive ? 'ok' : 'neutral'}>
                        {plan.isActive ? 'On sale' : 'Archived'}
                      </Badge>
                    </td>
                    {canManage && (
                      <td data-card="actions">
                        <div className="a-btn-row a-btn-row--end">
                          <button
                            type="button"
                            className="p-btn p-btn-ghost p-btn-sm"
                            onClick={() => setEditing(plan)}
                          >
                            Edit
                          </button>
                          {plan.isActive && (
                            <button
                              type="button"
                              className="p-btn p-btn-ghost p-btn-sm"
                              onClick={() => setArchiving(plan)}
                            >
                              Archive
                            </button>
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

        {editing !== undefined && (
          <PlanEditorModal
            // Remounts between create and edit so the form state resets —
            // without it, opening "New plan" after an edit inherits that
            // plan's values as defaults.
            key={editing?.id ?? 'new'}
            open
            existing={editing}
            onClose={() => setEditing(undefined)}
            onSaved={() => {
              setEditing(undefined);
              plans.reload();
            }}
          />
        )}

        {archiving !== null && (
          <ConfirmActionModal
            open
            title={`Archive ${archiving.name}?`}
            subtitle={
              'It disappears from the sale screens immediately. Members already on it keep ' +
              'their term and are unaffected. Nothing is deleted — past payments still name ' +
              'this plan.'
            }
            confirmLabel="Archive"
            cancelLabel="Keep selling it"
            // The modal owns busy and error itself; it only needs the work.
            onConfirm={() => adminApi.archivePlan(archiving.id).then(() => undefined)}
            onDone={() => plans.reload()}
            onClose={() => setArchiving(null)}
          />
        )}

        <div style={{ padding: '4px 18px 18px' }}>
          <p className="p-muted" style={{ fontSize: 13, lineHeight: 1.6, margin: 0 }}>
            A plan is <strong>archived, never deleted</strong> — memberships sold under it still
            reference it, and deleting one would orphan every term and every receipt that names it.
            Prices are snapshotted onto the membership at purchase, so changing a price here never
            rewrites what somebody already paid.
          </p>
        </div>
      </Card>

      <Card>
        <CardHead title="Operating parameters" />
        <p style={{ margin: '0 0 14px', fontSize: 14, lineHeight: 1.6, color: 'var(--p-ink2)' }}>
          Opening hours, the grace window, freeze limits and the attendance thresholds are set in
          the server environment and validated at boot a bad value stops the deploy rather than
          the front desk. They are shown here as read-only for a reason: making them editable from a
          browser moves a boot-time failure to 06:00 on a Monday, with a queue at the counter and
          nobody able to say why.
        </p>
        <div style={{ display: 'grid', gap: 8, fontSize: 13, color: 'var(--p-ink2)' }}>
          <ParamRow
            name="GYM_TIMEZONE"
            what="The gym's civil day. Every business date derives from it."
          />
          <ParamRow
            name="GYM_OPEN_TIME / GYM_CLOSE_TIME"
            what="The FALLBACK behind the editable hours above. Used only when the hours table cannot be read so a database problem never closes the door by accident."
          />
          <ParamRow
            name="MEMBERSHIP_GRACE_DAYS"
            what="Snapshotted onto each membership at purchase, so changing it never re-admits someone already turned away."
          />
          <ParamRow
            name="CHECKIN_STALE_VISIT_HOURS"
            what="Above this, a second scan closes the old visit and opens a new one."
          />
          <ParamRow
            name="CHECKIN_REENTRY_GRACE_MINUTES"
            what="Scan back in within this window of your own scan-out and it stays one visit stepping out for something forgotten never burns a daily slot."
          />
          <ParamRow
            name="CHECKIN_MAX_VISITS_PER_DAY"
            what="Members only. Staff who train are exempt."
          />
        </div>
      </Card>

      <Card>
        <CardHead title="Where the rest lives" />
        <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6, color: 'var(--p-ink2)' }}>
          Staff accounts are managed on{' '}
          <Link href="/admin/members" style={{ color: 'var(--gold-dark)' }}>
            Members
          </Link>{' '}
          open a member and use <em>Change role</em> (ADMIN-only) to make them front desk, coach
          or admin, and <em>Suspend</em> to disable them.
          {/* Each pointer only for a caller who can open the screen behind it. */}
          {canSeeCoaches ? (
            <>
              {' '}
              Coaches and their assignments live on{' '}
              <Link href="/admin/coaches" style={{ color: 'var(--gold-dark)' }}>
                Coaches
              </Link>
              .
            </>
          ) : null}
          {canSeeStations ? (
            <>
              {' '}
              Stations and their tablets live on{' '}
              <Link href="/admin/stations" style={{ color: 'var(--gold-dark)' }}>
                Stations
              </Link>
              .
            </>
          ) : null}{' '}
          Notification toggles, SMS and session-timeout controls have no source of truth in the
          system, so they are deliberately not shown as switches that would do nothing.
        </p>
      </Card>
    </div>
  );
}

function ParamRow({ name, what }: { name: string; what: string }) {
  return (
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
      {/* `min(…, 100%)` and `anywhere`: a 230px env-var name in a 300px
          phone card would otherwise push the page sideways. */}
      <code
        className="a-wrap"
        style={{ fontSize: 12, color: 'var(--p-ink)', minWidth: 'min(230px, 100%)' }}
      >
        {name}
      </code>
      <span style={{ flex: 1, minWidth: 'min(200px, 100%)' }}>{what}</span>
    </div>
  );
}
