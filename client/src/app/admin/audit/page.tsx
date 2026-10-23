'use client';

import { useCallback, useState } from 'react';
import { Badge, Card, CardHead } from '@/components/portal/ui';
import { DataState, Pager } from '@/components/admin/ui';
import { adminApi, civilDate, gymDateTime, type AuditEntry } from '@/lib/adminApi';
import { summariseAuditDetails } from '@/lib/auditSummary';
import { useAdminQuery } from '@/lib/useAdminQuery';

/**
 * Audit logs — the table behind a permission that has had none until now.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * `audit.read` HAS BEEN SEEDED SINCE THE RBAC WORK SHIPPED, WITH NO MODEL,
 * NO ROUTE AND NO SCREEN. The specs carried an "AuditLog is absent" caveat for
 * the whole of that time, and the proposal's own Settings screen links here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * FORWARD-ONLY, and the screen says so rather than letting a reader assume it.
 * Nothing before the first recorded entry exists, and an empty list under a
 * filter has to be distinguishable from an empty list because logging had not
 * started — which is why `recordingSince` is fetched separately and printed
 * even when the table is empty.
 *
 * Read-only. There is no resolve, no dismiss, no delete, and no compose. The
 * trail is append-only, and a screen that offered to tidy it would be the
 * first thing somebody used to tidy away their own entry.
 */

/** Every action, with the words a person would use for it. */
const ACTION_LABELS: Record<AuditEntry['action'], string> = {
  PAYMENT_VOIDED: 'Payment voided',
  PAYMENT_AMENDED: 'Payment corrected',
  PAYMENT_ARCHIVED: 'Payment archived',
  PAYMENT_UNARCHIVED: 'Payment restored',
  CHECKIN_OVERRIDDEN: 'Denial overridden',
  CHECKIN_VOIDED: 'Visit voided',
  MEMBER_SUSPENDED: 'Member suspended',
  MEMBER_REACTIVATED: 'Member reactivated',
  MEMBER_DELETED: 'Member deleted',
  MEMBER_RESTORED: 'Member restored',
  ROLE_CHANGED: 'Role changed',
  MEMBER_EMAIL_CHANGED: 'Member email corrected',
  // ── Staff & Access ──
  STAFF_INVITED: 'Staff invited',
  STAFF_INVITE_RESENT: 'Staff invite re-sent',
  STAFF_INVITE_REVOKED: 'Staff invite withdrawn',
  STAFF_INVITE_ACCEPTED: 'Staff invite accepted',
  COACH_PROFILE_UPDATED: 'Coach profile edited',
  // ── end Staff & Access ──
  PLAN_UPDATED: 'Plan edited',
  PLAN_ARCHIVED: 'Plan archived',
  OPENING_HOURS_CHANGED: 'Opening hours changed',
  // ── Announcements ──
  ANNOUNCEMENT_CREATED: 'Announcement posted',
  ANNOUNCEMENT_UPDATED: 'Announcement edited',
  ANNOUNCEMENT_DELETED: 'Announcement deleted',
  PROGRESS_MEASUREMENT_CORRECTED: 'Measurement corrected',
  PROGRESS_MEASUREMENT_DELETED: 'Measurement deleted',
  PROGRESS_GOAL_DELETED: 'Goal deleted',
  // ── Coach tools (feat/coach-tools) ──
  CHAT_THREAD_REVIEWED: 'Chat reviewed',
  CHAT_MESSAGE_DELETED: 'Chat message withdrawn',
  WORKOUT_PLAN_SAVED: 'Workout plan saved',
  ASSISTANT_INSTRUCTIONS_UPDATED: 'Assistant instructions edited',
  ASSISTANT_INSTRUCTIONS_RESET: 'Assistant instructions reset',
  GYM_EQUIPMENT_CHANGED: 'Equipment list changed',
  MEMBER_SELF_DELETED: 'Member deleted their account',
};

/**
 * Which entries read as a loss and which as a repair.
 *
 * Colour carries meaning on this screen, so it means one thing: danger is
 * "something was taken away or someone was let past a control", and ok is the
 * undo of one of those. Everything else is neutral — a plan price edit is
 * routine, and painting it red would teach staff to ignore red.
 */
const TONE: Record<AuditEntry['action'], 'danger' | 'warn' | 'ok' | 'neutral'> = {
  PAYMENT_VOIDED: 'danger',
  // WARN, NOT DANGER, and the distinction is the whole rule above. Danger on
  // this screen means "something was taken away or somebody was let past a
  // control". A properly trailed correction is neither — it leaves both rows
  // in the register with who, why and when — and painting it red teaches
  // staff to ignore red.
  PAYMENT_AMENDED: 'warn',
  // Archiving hides a row from the register and moves no figure at all. It is
  // still worth a name and a time, because the people who reconcile the till
  // will notice the row is gone.
  PAYMENT_ARCHIVED: 'warn',
  PAYMENT_UNARCHIVED: 'ok',
  CHECKIN_OVERRIDDEN: 'danger',
  CHECKIN_VOIDED: 'warn',
  MEMBER_SUSPENDED: 'warn',
  MEMBER_REACTIVATED: 'ok',
  MEMBER_DELETED: 'danger',
  MEMBER_RESTORED: 'ok',
  // A login address changed: legitimate for a typo at the counter, and worth noticing.
  MEMBER_EMAIL_CHANGED: 'warn',
  ROLE_CHANGED: 'warn',
  // ── Staff & Access ──
  // An invitation hands out access, so issuing one reads as a warning, like a
  // role change; taking one up IS the role change. Withdrawing one takes
  // nothing away from anybody who has it — the repair tone.
  STAFF_INVITED: 'warn',
  STAFF_INVITE_RESENT: 'neutral',
  STAFF_INVITE_REVOKED: 'ok',
  STAFF_INVITE_ACCEPTED: 'warn',
  // What members read about a coach: routine, like a plan edit.
  COACH_PROFILE_UPDATED: 'neutral',
  // ── end Staff & Access ──
  PLAN_UPDATED: 'neutral',
  PLAN_ARCHIVED: 'neutral',
  OPENING_HOURS_CHANGED: 'neutral',
  // ── Announcements ── Posting and editing are the board working as meant.
  // Deleting takes a notice away from every member for good, so it warns —
  // not danger: no money moved and no control was bypassed.
  ANNOUNCEMENT_CREATED: 'neutral',
  ANNOUNCEMENT_UPDATED: 'neutral',
  ANNOUNCEMENT_DELETED: 'warn',
  // A coach fixing a reading is routine, like a plan edit. Deleting one takes
  // part of a member's record away for good, so it reads as a warning — not
  // danger: it is a coach tidying their own member's history, not a control
  // being bypassed.
  PROGRESS_MEASUREMENT_CORRECTED: 'neutral',
  PROGRESS_MEASUREMENT_DELETED: 'warn',
  PROGRESS_GOAL_DELETED: 'warn',
  // ── Coach tools (feat/coach-tools) ──
  // Reading somebody else's private conversation is legitimate only for a
  // complaint, and the entry carries the reason — WARN, so it is noticed.
  CHAT_THREAD_REVIEWED: 'warn',
  // A sender taking back their own words inside ten minutes is routine.
  CHAT_MESSAGE_DELETED: 'neutral',
  WORKOUT_PLAN_SAVED: 'neutral',
  // What the member assistant is told: an owner decision, routine like a plan edit.
  ASSISTANT_INSTRUCTIONS_UPDATED: 'neutral',
  ASSISTANT_INSTRUCTIONS_RESET: 'neutral',
  // What the AI planners may use: routine, like the assistant's instructions.
  GYM_EQUIPMENT_CHANGED: 'neutral',
  MEMBER_SELF_DELETED: 'warn',
};

const PAGE_SIZE = 25;

export default function AdminAuditPage() {
  const [action, setAction] = useState<'' | AuditEntry['action']>('');
  const [page, setPage] = useState(1);

  const entries = useAdminQuery(
    useCallback(
      () =>
        adminApi.audit({
          page,
          limit: PAGE_SIZE,
          ...(action === '' ? {} : { action }),
        }),
      [action, page],
    ),
    `audit:${action}:${page}`,
  );

  const coverage = useAdminQuery(
    useCallback(() => adminApi.auditCoverage(), []),
    'audit-coverage',
  );

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <Card>
        <CardHead
          title="Audit log"
          action={
            <span className="p-muted" style={{ fontSize: 12.5 }}>
              {entries.data?.total ?? 0} recorded
            </span>
          }
        />

        <div className="a-toolbar" style={{ paddingTop: 12, flexWrap: 'wrap' }}>
          <label>
            <span className="a-person-sub">ACTION</span>
            <select
              className="a-input"
              value={action}
              onChange={(event) => {
                setAction(event.target.value as '' | AuditEntry['action']);
                // A filter change must not leave the pager on a page the new
                // result set does not have.
                setPage(1);
              }}
            >
              <option value="">Everything</option>
              {(Object.keys(ACTION_LABELS) as AuditEntry['action'][]).map((key) => (
                <option key={key} value={key}>
                  {ACTION_LABELS[key]}
                </option>
              ))}
            </select>
          </label>
        </div>

        {/*
          THE HONESTY LINE. Without it an empty table reads as "nothing has
          ever gone wrong here", which is the single most misleading thing an
          audit screen can imply.
        */}
        <p style={{ margin: '12px 0 0', fontSize: 13, color: 'var(--p-ink2)', lineHeight: 1.6 }}>
          {coverage.data == null ? (
            'Recording of dangerous actions is forward-only.'
          ) : coverage.data.recordingSince === null ? (
            <>
              <strong>Nothing recorded yet.</strong> Logging is forward-only, so this stays empty
              until the next payment void, denial override, suspension, role change, plan edit or
              hours change. It is not a record that nothing has happened.
            </>
          ) : (
            <>
              Recording started{' '}
              <strong>{civilDate(coverage.data.recordingSince.slice(0, 10))}</strong>. Anything
              before that date was never logged forward-only, with no back-fill so a gap means
              &ldquo;not recorded&rdquo;, never &ldquo;did not happen&rdquo;.
            </>
          )}
        </p>
      </Card>

      <Card padded={false}>
        <DataState
          loading={entries.loading}
          error={entries.error}
          empty={(entries.data?.items.length ?? 0) === 0}
          emptyTitle={action === '' ? 'Nothing recorded yet' : 'No entries of that kind'}
          emptyHint="Payment voids, denial overrides, suspensions, deletions, role changes, plan edits and opening-hours changes are recorded here as they happen."
          onRetry={entries.reload}
        >
          <div className="a-scroll">
            <table className="p-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Action</th>
                  <th>Who</th>
                  <th>What</th>
                  <th>Why</th>
                </tr>
              </thead>
              <tbody>
                {entries.data?.items.map((row) => {
                  const changes = summariseAuditDetails(row.action, row.details);

                  return (
                    <tr key={row.id}>
                      <td className="p-muted" style={{ whiteSpace: 'nowrap' }}>
                        {gymDateTime(row.occurredAt)}
                      </td>
                      <td>
                        <Badge tone={TONE[row.action]}>{ACTION_LABELS[row.action]}</Badge>
                      </td>
                      <td>
                        <strong>{row.actorName}</strong>
                        {/* The role AT THE TIME. A later promotion must not
                            rewrite what somebody was when they did it. */}
                        <div className="a-person-sub">{row.actorRole} at the time</div>
                      </td>
                      <td>
                        {row.subjectLabel ?? row.subjectType}
                        <div className="a-person-sub">
                          {row.subjectType}
                          {changes === null ? '' : ` · ${changes}`}
                        </div>
                      </td>
                      <td className="p-muted" style={{ maxWidth: 260 }}>
                        {row.reason ?? '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div style={{ padding: '0 18px 18px' }}>
            <Pager
              page={entries.data?.page ?? 1}
              limit={entries.data?.limit ?? PAGE_SIZE}
              total={entries.data?.total ?? 0}
              onPage={setPage}
            />
          </div>
        </DataState>
      </Card>
    </div>
  );
}
