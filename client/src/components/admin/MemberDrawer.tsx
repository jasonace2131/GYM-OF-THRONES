'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '@/components/portal/ui';
import {
  adminApi,
  civilDate,
  duration,
  gymDateTime,
  peso,
  type MemberListItem,
  type MembershipDetail,
} from '@/lib/adminApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import { confirmErrorMessage } from '@/lib/confirm';
import { Drawer } from './Drawer';
import { PrintSlipButton } from './PrintSlipButton';
import { PERMISSIONS } from '@got/shared';
import { useCan, useMe } from '@/components/rbac/MeProvider';
import {
  accountActionAvailability,
  roleChangeAvailability,
  type ActionAvailability,
} from '@/lib/staff/staffRules';
import { DaysLeft, Person, StandingBadge } from './ui';
import { ChangeEmailModal } from './actions/ChangeEmailModal';
import { ChangeRoleModal } from './actions/ChangeRoleModal';
import { ConfirmActionModal } from './actions/ConfirmActionModal';
import { EditMemberModal } from './actions/EditMemberModal';
import { FreezeMembershipModal } from './actions/FreezeMembershipModal';
import { ReasonActionModal } from './actions/ReasonActionModal';
import { RecordPaymentModal } from './actions/RecordPaymentModal';
import { SellMembershipModal } from './actions/SellMembershipModal';

/**
 * The member drawer — C5.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * PERMISSION GATING HIDES CONTROLS, IT DOES NOT DISABLE THEM.
 *
 * Same rule as `admin/layout.tsx`'s nav: the caller's own `GET /me` permission
 * list (`useCan()`, from the SAME `MeProvider` the shell already populates) decides
 * which buttons exist at all. A disabled "Suspend" button a front-desk
 * operator can see but never click just advertises a capability they don't
 * have; hiding it is honest about what this account can do, and every route
 * behind it is permission-checked server-side regardless.
 *
 * NO OPTIMISTIC WRITES. Every action opens a `Modal` (never mutates directly),
 * and every one of them, on success, both (a) updates this drawer's own local
 * snapshot from the server's response and (b) reloads the caller's
 * `useAdminQuery` — the roster's for profile/membership changes, this
 * drawer's own payments/attendance queries for money and visit changes.
 * ─────────────────────────────────────────────────────────────────────────
 */

type DrawerAction =
  | { kind: 'edit' }
  | { kind: 'role' }
  | { kind: 'suspend' }
  | { kind: 'reactivate' }
  | { kind: 'delete' }
  | { kind: 'restore' }
  | { kind: 'resendInvite' }
  | { kind: 'changeEmail' }
  | { kind: 'assignPlan' }
  | { kind: 'replacePlan' }
  | { kind: 'freeze' }
  | { kind: 'cancel' }
  | { kind: 'recordPayment' }
  | { kind: 'void'; paymentId: string }
  | { kind: 'refund'; paymentId: string }
  | null;

/** "Resend invite" answered 200 but the email did not go out. */
class SetupEmailNotSent extends Error {
  constructor() {
    super('The setup link email may not have gone out. Check the address, or try again later.');
  }
}

/** `MembershipDetail` (write response) → the roster row's `membership`
 *  shape, so a sell/renew/freeze response can update the drawer in place
 *  without a second fetch. */
function applyMembershipDetail(member: MemberListItem, detail: MembershipDetail): MemberListItem {
  return {
    ...member,
    membership: {
      id: detail.id,
      planCode: detail.planCode,
      planName: detail.planName,
      status: detail.status,
      startsOn: detail.startsOn,
      endsOn: detail.endsOn,
      daysRemaining: detail.verdict.daysRemaining,
      // Already on `MembershipDetail`, so this costs no fetch. Omitting it is
      // a type error rather than a silent stale field, which is the argument
      // for widening `MemberListItem` first and fixing the call sites after.
      cancelRequestedOn: detail.cancelRequestedOn,
    },
    decision: detail.verdict.decision,
    allowReason: detail.verdict.allowReason,
    denialReason: detail.verdict.denialReason,
  };
}

export function MemberDrawer({
  member: initialMember,
  onClose,
  reloadList,
  activeAdmins,
}: {
  member: MemberListItem;
  onClose: () => void;
  reloadList: () => void;
  /**
   * Staff & Access: how many ADMINs are active, when the caller knows —
   * the staff screen does, the member roster does not. Lets the drawer
   * disable "last admin" actions with a reason instead of letting the
   * server refuse them. Omitted, the server still enforces the rule.
   */
  activeAdmins?: number;
}) {
  const { me } = useMe();
  const can = useCan();

  const [member, setMember] = useState(initialMember);

  // ── Staff & Access: the role hierarchy decides which account actions
  // exist here. Never-possible ones (an ADMIN on another ADMIN, anything on
  // the Super Admin) are hidden; "your own account" and "the last active
  // admin" are shown disabled, with the reason — see lib/staff/staffRules.
  const caller = me === null ? null : { id: me.id, role: me.role };
  const facts = {
    id: member.userId,
    role: member.role,
    status: member.status,
    deletedAt: member.deletedAt,
  };
  const roleAction = roleChangeAvailability(caller, facts, {
    canChange: can(PERMISSIONS.ROLE_CHANGE),
    activeAdmins,
  });
  const accountAction = (
    action: 'suspend' | 'reactivate' | 'delete' | 'restore',
    key: string,
  ): ActionAvailability =>
    accountActionAvailability(caller, facts, action, { allowed: can(key), activeAdmins });
  const [action, setAction] = useState<DrawerAction>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const kebabRef = useRef<HTMLDivElement | null>(null);

  const fullName = `${member.firstName} ${member.lastName}`;
  const membershipId = member.membership?.id ?? null;

  // Mirrors `Drawer`'s own internal `requestClose` (and `Modal.tsx`'s before
  // it): the header's hand-rolled X button is NOT wired through the Drawer's
  // busy gate automatically just because `<Drawer busy={action !== null}>`
  // is set — that only governs Escape/backdrop-click, which are handled
  // inside `Drawer` itself. This button lives in `MemberDrawer`'s own JSX,
  // so it needs the same guard applied explicitly.
  const requestClose = (): void => {
    if (action !== null) return;
    onClose();
  };

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (event: MouseEvent): void => {
      if (kebabRef.current?.contains(event.target as Node) === false) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  const paymentsQuery = useAdminQuery(
    useCallback(() => adminApi.payments({ userId: member.userId, limit: 8 }), [member.userId]),
    `drawer-payments:${member.userId}`,
  );

  const checkInsQuery = useAdminQuery(
    useCallback(() => adminApi.checkIns({ userId: member.userId, limit: 8 }), [member.userId]),
    `drawer-checkins:${member.userId}`,
  );

  // A drawer opened from the roster's "Deleted" filter is looking at a row
  // that no other read can even see. Every action below acts through a route
  // whose own `deletedAt: null` guard would 404 it, so offering Edit / Suspend
  // / Delete here would be offering nothing but errors. Restore is the ONE
  // thing that works on a deleted member, and it replaces the menu outright
  // rather than joining it.
  const isDeleted = member.deletedAt !== null;

  const menuItems: {
    key: string;
    label: string;
    danger?: boolean;
    /** Shown but not clickable, with the reason under the label. */
    disabledReason?: string;
    onSelect: () => void;
  }[] = [];
  /** Add a hierarchy-governed item: hidden, disabled with its reason, or live. */
  const pushGoverned = (
    availability: ActionAvailability,
    item: { key: string; label: string; danger?: boolean; onSelect: () => void },
  ): void => {
    if (availability.state === 'hidden') return;
    menuItems.push(
      availability.state === 'disabled' ? { ...item, disabledReason: availability.reason } : item,
    );
  };

  if (isDeleted) {
    pushGoverned(accountAction('restore', PERMISSIONS.MEMBER_DELETE), {
      key: 'restore',
      label: 'Restore member',
      onSelect: () => setAction({ kind: 'restore' }),
    });
  } else {
    if (can(PERMISSIONS.MEMBER_UPDATE)) {
      menuItems.push({ key: 'edit', label: 'Edit', onSelect: () => setAction({ kind: 'edit' }) });
    }
    pushGoverned(roleAction, {
      key: 'role',
      label: 'Change role',
      onSelect: () => setAction({ kind: 'role' }),
    });
    if (member.status === 'SUSPENDED') {
      pushGoverned(accountAction('reactivate', PERMISSIONS.MEMBER_SUSPEND), {
        key: 'reactivate',
        label: 'Reactivate',
        onSelect: () => setAction({ kind: 'reactivate' }),
      });
    } else {
      pushGoverned(accountAction('suspend', PERMISSIONS.MEMBER_SUSPEND), {
        key: 'suspend',
        label: 'Suspend',
        danger: true,
        onSelect: () => setAction({ kind: 'suspend' }),
      });
    }
    // Setup links are for member accounts only; the server refuses staff ones.
    if (can(PERMISSIONS.MEMBER_CREATE) && member.lastSeenAt === null && member.role === 'CLIENT') {
      menuItems.push({
        key: 'resendInvite',
        label: 'Resend invite',
        onSelect: () => setAction({ kind: 'resendInvite' }),
      });
      menuItems.push({
        key: 'changeEmail',
        label: 'Change email',
        onSelect: () => setAction({ kind: 'changeEmail' }),
      });
    }
    pushGoverned(accountAction('delete', PERMISSIONS.MEMBER_DELETE), {
      key: 'delete',
      label: 'Delete member',
      danger: true,
      onSelect: () => setAction({ kind: 'delete' }),
    });
  }

  return (
    <>
      <Drawer open label={fullName} busy={action !== null} onClose={onClose}>
        <div className="a-drawer-head">
          <div className="a-drawer-head-main">
            <Person
              firstName={member.firstName}
              lastName={member.lastName}
              sub={member.email}
              avatarUrl={member.avatarUrl}
            />
            <div className="a-drawer-chips">
              {isDeleted && <Badge tone="danger">Deleted</Badge>}
              <StandingBadge
                decision={member.decision}
                daysRemaining={member.membership?.daysRemaining ?? null}
                hasMembership={member.membership !== null}
              />
              <Badge tone="neutral">{member.role.replace('_', ' ')}</Badge>
              {member.memberCode !== null && (
                <span className="a-drawer-code">{member.memberCode}</span>
              )}
            </div>
            {/*
             * At a glance: PHONE and JOINED.
             *
             * Both are here because the roster's table drops them on a narrow
             * viewport — Contact below 760px, Joined below 1180px. Hiding a
             * phone number on the screen whose entire purpose is ringing
             * people would be a real loss rather than a responsive one, so
             * the drawer has to carry it. Neither was in this header before
             * the Subscriptions merge.
             */}
            <p className="a-drawer-row-sub" style={{ margin: 0 }}>
              {member.phone ?? 'No phone on file'} · joined {civilDate(member.joinedOn)}
            </p>
            {member.emergencyContact !== null && member.emergencyContact !== '' && (
              <p className="a-drawer-row-sub" style={{ margin: 0 }}>
                Emergency contact: {member.emergencyContact}
              </p>
            )}
          </div>

          <div className="a-drawer-head-actions">
            {menuItems.length > 0 && (
              <div className="a-kebab" ref={kebabRef}>
                <button
                  type="button"
                  className="a-kebab-btn"
                  aria-haspopup="menu"
                  aria-expanded={menuOpen}
                  aria-label="Member actions"
                  onClick={() => setMenuOpen((v) => !v)}
                >
                  ⋯
                </button>
                {menuOpen && (
                  <ul className="a-kebab-menu" role="menu">
                    {menuItems.map((item) => (
                      <li key={item.key} role="none">
                        <button
                          type="button"
                          role="menuitem"
                          className="a-kebab-item"
                          data-danger={
                            (item.danger === true && item.disabledReason === undefined) ||
                            undefined
                          }
                          disabled={item.disabledReason !== undefined}
                          aria-disabled={item.disabledReason !== undefined || undefined}
                          style={
                            item.disabledReason === undefined
                              ? undefined
                              : { cursor: 'not-allowed', color: 'var(--p-ink3)' }
                          }
                          onClick={() => {
                            if (item.disabledReason !== undefined) return;
                            setMenuOpen(false);
                            item.onSelect();
                          }}
                        >
                          {item.label}
                          {item.disabledReason === undefined ? null : (
                            <span
                              style={{
                                display: 'block',
                                marginTop: 2,
                                fontSize: 11.5,
                                lineHeight: 1.35,
                                color: 'var(--p-ink3)',
                                whiteSpace: 'normal',
                              }}
                            >
                              {item.disabledReason}
                            </span>
                          )}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            <button
              type="button"
              className="a-modal-x"
              onClick={requestClose}
              disabled={action !== null}
              aria-label="Close"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                aria-hidden
              >
                <path d="M18 6L6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="a-drawer-body">
          {/* ── Membership ─────────────────────────────────────── */}
          <section>
            <div className="a-drawer-section-head">
              <h3 className="a-drawer-section-title">Membership</h3>
              {/* Same reasoning as the kebab menu above: every one of these
                  routes resolves the member through a `deletedAt: null`
                  filter, so on a deleted row they are buttons that can only
                  404. History below stays readable — it is why the drawer
                  opens at all. */}
              <div className="a-drawer-section-actions">
                {!isDeleted && can(PERMISSIONS.MEMBERSHIP_SELL) && member.membership === null && (
                  <button
                    type="button"
                    className="p-btn p-btn-ghost p-btn-sm"
                    onClick={() => setAction({ kind: 'assignPlan' })}
                  >
                    Assign plan
                  </button>
                )}
                {!isDeleted && can(PERMISSIONS.MEMBERSHIP_SELL) && member.membership !== null && (
                  <button
                    type="button"
                    className="p-btn p-btn-ghost p-btn-sm"
                    onClick={() => setAction({ kind: 'replacePlan' })}
                  >
                    Replace plan
                  </button>
                )}
                {!isDeleted && can(PERMISSIONS.MEMBERSHIP_FREEZE) && member.membership !== null && (
                  <button
                    type="button"
                    className="p-btn p-btn-ghost p-btn-sm"
                    onClick={() => setAction({ kind: 'freeze' })}
                  >
                    Freeze
                  </button>
                )}
                {!isDeleted && can(PERMISSIONS.MEMBERSHIP_CANCEL) && member.membership !== null && (
                  <button
                    type="button"
                    className="p-btn p-btn-ghost p-btn-sm"
                    onClick={() => setAction({ kind: 'cancel' })}
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>

            {member.membership === null ? (
              <p className="a-drawer-empty">No plan on file.</p>
            ) : (
              <div style={{ display: 'grid', gap: 6 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="a-drawer-row-title">{member.membership.planName}</div>
                    <div className="a-drawer-row-sub">
                      {civilDate(member.membership.startsOn)} – {civilDate(member.membership.endsOn)}
                    </div>
                  </div>
                  <DaysLeft days={member.membership.daysRemaining} />
                </div>
                {/* Notice, not termination: the term runs to its end date and
                    the door keeps letting them in until it does. The roster's
                    Ends column carries the same fact as a one-word sub-line;
                    here there is room for the date it was given. */}
                {member.membership.cancelRequestedOn !== null && (
                  <p className="a-drawer-row-sub">
                    cancelling — notice given {civilDate(member.membership.cancelRequestedOn)}
                  </p>
                )}
                {member.allowReason !== null && (
                  <p className="a-drawer-row-sub">Allowed: {member.allowReason}</p>
                )}
                {member.denialReason !== null && (
                  <p className="a-drawer-row-sub">Denied: {member.denialReason}</p>
                )}
              </div>
            )}
          </section>

          {/* ── Payments ───────────────────────────────────────── */}
          <section>
            <div className="a-drawer-section-head">
              <h3 className="a-drawer-section-title">Payments</h3>
              <div className="a-drawer-section-actions">
                {!isDeleted && can(PERMISSIONS.PAYMENT_RECORD) && (
                  <button
                    type="button"
                    className="p-btn p-btn-ghost p-btn-sm"
                    onClick={() => setAction({ kind: 'recordPayment' })}
                  >
                    Record payment
                  </button>
                )}
              </div>
            </div>

            {paymentsQuery.loading ? (
              <p className="a-drawer-empty">Loading…</p>
            ) : paymentsQuery.error !== null ? (
              <p className="a-drawer-empty">{paymentsQuery.error}</p>
            ) : (paymentsQuery.data?.items.length ?? 0) === 0 ? (
              <p className="a-drawer-empty">No payments recorded.</p>
            ) : (
              <div>
                {paymentsQuery.data!.items.map((payment) => (
                  <div key={payment.id} className="a-drawer-row">
                    <div className="a-drawer-row-main">
                      <div className="a-drawer-row-title">
                        {payment.planName} · {payment.method}
                      </div>
                      <div className="a-drawer-row-sub">
                        {gymDateTime(payment.receivedAt)}
                        {payment.reference !== null ? ` · ref ${payment.reference}` : ''}
                      </div>
                      {payment.voidKind !== null && (
                        <Badge tone="danger">{payment.voidKind}</Badge>
                      )}
                    </div>
                    <span className="a-drawer-row-amount">
                      {peso(payment.netCentavos, { decimals: true })}
                    </span>
                    {/* Seeing this section already required payment.read —
                        the key the receipt route carries. A drawer print is a
                        reissue: copy. */}
                    <PrintSlipButton paymentId={payment.id} copy />
                    {payment.status === 'RECORDED' && can(PERMISSIONS.PAYMENT_VOID) && (
                      <div className="a-drawer-row-actions">
                        <button
                          type="button"
                          className="p-btn p-btn-ghost p-btn-sm"
                          onClick={() => setAction({ kind: 'void', paymentId: payment.id })}
                        >
                          Void
                        </button>
                        <button
                          type="button"
                          className="p-btn p-btn-danger p-btn-sm"
                          onClick={() => setAction({ kind: 'refund', paymentId: payment.id })}
                        >
                          Refund
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Attendance ─────────────────────────────────────── */}
          <section>
            <div className="a-drawer-section-head">
              <h3 className="a-drawer-section-title">Attendance</h3>
              <span className="p-muted" style={{ fontSize: 11, marginLeft: 'auto' }}>
                {member.checkInCount} visits total
              </span>
            </div>

            {checkInsQuery.loading ? (
              <p className="a-drawer-empty">Loading…</p>
            ) : checkInsQuery.error !== null ? (
              <p className="a-drawer-empty">{checkInsQuery.error}</p>
            ) : (checkInsQuery.data?.items.length ?? 0) === 0 ? (
              <p className="a-drawer-empty">No visits recorded.</p>
            ) : (
              <div>
                {checkInsQuery.data!.items.map((visit) => (
                  <div key={visit.checkInId} className="a-drawer-row">
                    <div className="a-drawer-row-main">
                      <div className="a-drawer-row-title">
                        {visit.entryType === 'MEMBERSHIP'
                          ? 'Membership'
                          : visit.entryType === 'WALK_IN'
                            ? 'Walk-in'
                            : 'Guest pass'}
                        {visit.voidedAt !== null ? ' · voided' : ''}
                      </div>
                      <div className="a-drawer-row-sub">
                        {gymDateTime(visit.occurredAt)}
                        {visit.station !== null ? ` · ${visit.station.name}` : ''}
                      </div>
                    </div>
                    <span
                      className="a-drawer-row-amount"
                      style={{ fontWeight: 400, color: 'var(--p-ink3)' }}
                    >
                      {visit.durationMinutes !== null ? duration(visit.durationMinutes) : '—'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ── Notes / audit ──────────────────────────────────── */}
          {/* Deliberately omitted: `adminApi` has no audit-log wrapper for a
              member subject (grepped — none exists), and the repo rule is to
              show nothing the client cannot source rather than invent a
              section that always reads empty. Flagged in the C5 report. */}
        </div>
      </Drawer>

      <EditMemberModal
        open={action?.kind === 'edit'}
        member={member}
        onClose={() => setAction(null)}
        onSaved={(updated) => {
          setMember(updated);
          reloadList();
        }}
      />

      <ChangeRoleModal
        open={action?.kind === 'role'}
        member={member}
        onClose={() => setAction(null)}
        onChanged={(updated) => {
          setMember(updated);
          reloadList();
        }}
      />

      <ReasonActionModal
        open={action?.kind === 'suspend'}
        title={`Suspend ${fullName}?`}
        subtitle={`${fullName} will be blocked at the door. Portal login is unaffected.`}
        confirmLabel="Suspend"
        cancelLabel="Keep active"
        danger
        placeholder="Why is this member being suspended?"
        onConfirm={async (reason) => {
          const updated = await adminApi.suspendMember(member.userId, reason);
          setMember(updated);
        }}
        onClose={() => setAction(null)}
        onDone={() => reloadList()}
      />

      <ConfirmActionModal
        open={action?.kind === 'reactivate'}
        title={`Reactivate ${fullName}?`}
        subtitle={`Clear the suspension on ${fullName} — check-in access is restored immediately.`}
        confirmLabel="Reactivate"
        cancelLabel="Keep suspended"
        onConfirm={async () => {
          const updated = await adminApi.reactivateMember(member.userId);
          setMember(updated);
        }}
        onClose={() => setAction(null)}
        onDone={() => reloadList()}
      />

      <ConfirmActionModal
        open={action?.kind === 'delete'}
        title={`Delete ${fullName}?`}
        subtitle={`This soft-deletes ${fullName}'s account. This cannot be undone from here.`}
        confirmLabel="Delete member"
        cancelLabel="Keep member"
        danger
        onConfirm={async () => {
          await adminApi.deleteMember(member.userId);
        }}
        onClose={() => setAction(null)}
        onDone={() => {
          reloadList();
          onClose();
        }}
      />

      {/* Closes the drawer on success, exactly like Delete: the roster behind
          it is filtered to `deleted=true`, so a restored member is no longer
          one of its rows and a drawer left open would be floating over a list
          that no longer contains it. */}
      <ConfirmActionModal
        open={action?.kind === 'restore'}
        title={`Restore ${fullName}?`}
        subtitle={`Put ${fullName} back on the roster. Their plan, payments and visit history are untouched.`}
        confirmLabel="Restore member"
        cancelLabel="Leave deleted"
        onConfirm={async () => {
          await adminApi.restoreMember(member.userId);
        }}
        onClose={() => setAction(null)}
        onDone={() => {
          reloadList();
          onClose();
        }}
      />

      <ConfirmActionModal
        open={action?.kind === 'resendInvite'}
        title={`Send ${fullName} a new setup link?`}
        subtitle={`Emails a new setup link to ${member.email}. The old link stops working.`}
        confirmLabel="Send link"
        cancelLabel="Don't send"
        onConfirm={async () => {
          // A 200 with `emailSent: false` is not a success to close on: the old
          // link is dead and the new one may be in nobody's inbox.
          const { emailSent } = await adminApi.resendInvite(member.userId);
          if (!emailSent) throw new SetupEmailNotSent();
        }}
        describeError={(caught) =>
          caught instanceof SetupEmailNotSent ? caught.message : confirmErrorMessage(caught)
        }
        onClose={() => setAction(null)}
        onDone={() => reloadList()}
      />

      <ChangeEmailModal
        open={action?.kind === 'changeEmail'}
        member={member}
        onClose={() => setAction(null)}
        onSaved={(updated) => {
          setMember(updated);
          reloadList();
        }}
      />

      <SellMembershipModal
        open={action?.kind === 'assignPlan' || action?.kind === 'replacePlan'}
        mode={action?.kind === 'replacePlan' ? 'renew' : 'sell'}
        userId={member.userId}
        membershipId={membershipId ?? undefined}
        memberName={fullName}
        onClose={() => setAction(null)}
        onSold={(detail) => {
          setMember((prev) => applyMembershipDetail(prev, detail));
          reloadList();
        }}
      />

      {membershipId !== null && (
        <FreezeMembershipModal
          open={action?.kind === 'freeze'}
          membershipId={membershipId}
          memberName={fullName}
          onClose={() => setAction(null)}
          onFrozen={(detail) => {
            setMember((prev) => applyMembershipDetail(prev, detail));
            reloadList();
          }}
        />
      )}

      {membershipId !== null && (
        <ReasonActionModal
          open={action?.kind === 'cancel'}
          title={`Cancel ${fullName}'s membership?`}
          subtitle="This forfeits the rest of the paid term. Dangerous — cannot be undone."
          confirmLabel="Cancel membership"
          cancelLabel="Keep membership"
          danger
          placeholder="Why is this membership being cancelled?"
          onConfirm={async (reason) => {
            const detail = await adminApi.cancelMembership(membershipId, reason);
            setMember((prev) => applyMembershipDetail(prev, detail));
          }}
          onClose={() => setAction(null)}
          onDone={() => reloadList()}
        />
      )}

      <RecordPaymentModal
        open={action?.kind === 'recordPayment'}
        userId={member.userId}
        memberName={fullName}
        onClose={() => setAction(null)}
        onRecorded={() => {
          paymentsQuery.reload();
          reloadList();
        }}
      />

      <ReasonActionModal
        open={action?.kind === 'void'}
        title={`Void this payment for ${fullName}?`}
        subtitle="No money moved — this marks the payment as recorded in error."
        confirmLabel="Void payment"
        cancelLabel="Keep payment"
        danger
        placeholder="Why is this payment being voided?"
        onConfirm={async (reason) => {
          if (action?.kind !== 'void') return;
          await adminApi.voidPayment(action.paymentId, reason, 'VOID');
        }}
        onClose={() => setAction(null)}
        onDone={() => paymentsQuery.reload()}
      />

      <ReasonActionModal
        open={action?.kind === 'refund'}
        title={`Refund this payment to ${fullName}?`}
        subtitle="Money was returned to the member."
        confirmLabel="Refund payment"
        cancelLabel="Keep payment"
        danger
        placeholder="Why is this payment being refunded?"
        onConfirm={async (reason) => {
          if (action?.kind !== 'refund') return;
          await adminApi.voidPayment(action.paymentId, reason, 'REFUND');
        }}
        onClose={() => setAction(null)}
        onDone={() => paymentsQuery.reload()}
      />
    </>
  );
}
