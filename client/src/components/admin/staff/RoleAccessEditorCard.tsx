'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import {
  ROLE_ACCESS_REASON_MAX,
  ROLE_ACCESS_REASON_MIN,
  isLockedForRole,
  roleLabel,
} from '@got/shared';
import { Badge, Card } from '@/components/portal/ui';
import { DataState } from '@/components/admin/ui';
import { Modal, ModalError } from '@/components/admin/Modal';
import { useMe } from '@/components/rbac/MeProvider';
import { gymDateTime } from '@/lib/adminApi';
import { confirmErrorMessage } from '@/lib/confirm';
import { staffApi } from '@/lib/staffApi';
import { useAdminQuery } from '@/lib/useAdminQuery';
import {
  canGrant,
  changeCount,
  changedKeys,
  dangerousGrants,
  definitionsByKey,
  diffDraft,
  fromDraft,
  rowLock,
  toDraft,
  turnOff,
  turnOn,
  visibleGroups,
  resourceHeading,
  type AccessChange,
  type AccessRole,
  type Draft,
  type RoleAccessRoleView,
  type RowFilter,
} from '@/lib/staff/accessEditor';
import type { GrantScope, PermissionDefinitionView } from '@/lib/staff/roleMatrix';

const FILTERS: Array<{ value: RowFilter; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'on', label: 'Turned on' },
  { value: 'changed', label: 'Changed' },
];

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/**
 * Staff & Access → "Edit role access" (feat/role-access-editor, owner 2026-11-07).
 *
 * A SEPARATE card from the read-only "What each role can do" table, which the
 * owner asked to keep as it is. One role at a time, switches instead of a grid.
 *
 * Every rule the switches follow is the server's rule asked in advance
 * (`lib/staff/accessEditor.ts`, `@got/shared` role-access-rules): which roles
 * this caller may edit, the keys locked on for Admin, prerequisites coming on
 * and dependents going off together, and no handing out what you do not hold.
 * The server checks all of it again on save.
 */
export function RoleAccessEditorCard({ onSaved }: { onSaved?: () => void }) {
  const { me } = useMe();
  const data = useAdminQuery(
    useCallback(async () => {
      const [catalogue, access] = await Promise.all([
        staffApi.permissionCatalogue(),
        staffApi.roleAccess(),
      ]);
      return { catalogue, access };
    }, []),
    'staff-role-access',
  );

  const [picked, setPicked] = useState<AccessRole | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<AccessRole, Draft>>>({});
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<RowFilter>('all');
  const [note, setNote] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'review' | 'reset' | null>(null);

  const defs = useMemo(
    () =>
      data.data === null
        ? new Map<string, PermissionDefinitionView>()
        : definitionsByKey(data.data.catalogue),
    [data.data],
  );
  const scopable = useMemo(() => new Set(data.data?.access.scopableKeys ?? []), [data.data]);
  const actorHeld = useMemo(
    () =>
      toDraft(
        (me?.permissions ?? []).map((p) => ({
          key: p.key,
          scope: p.scope === 'OWN' ? 'OWN' : 'ALL',
        })),
      ),
    [me],
  );

  const roles = data.data?.access.roles ?? [];
  const current: RoleAccessRoleView | undefined =
    roles.find((r) => r.role === picked) ?? roles.find((r) => r.editable) ?? roles[0];
  const role = current?.role ?? 'FRONT_DESK';
  const base = useMemo(() => toDraft(current?.grants ?? []), [current]);
  const defaults = useMemo(() => toDraft(current?.defaults ?? []), [current]);
  const draft = drafts[role] ?? base;
  const change = diffDraft(base, draft);
  const pending = changedKeys(change);
  const custom = changedKeys(diffDraft(defaults, base));
  const editable = current?.editable === true;
  const name = roleLabel(role);

  const label = (key: string): string => defs.get(key)?.description ?? key;
  const setDraft = (next: Draft): void => {
    setDrafts((all) => ({ ...all, [role]: next }));
    setSaved(null);
  };

  const flip = (def: PermissionDefinitionView): void => {
    if (draft[def.key] === undefined) {
      const result = turnOn(draft, def.key, defs, defaults, scopable);
      setDraft(result.draft);
      setNote(
        result.alsoOn.length === 0
          ? null
          : `${def.description} needs ${result.alsoOn.map(label).join(', ')}, so ${result.alsoOn.length === 1 ? 'it was' : 'they were'} turned on too.`,
      );
    } else {
      const result = turnOff(draft, def.key, defs);
      setDraft(result.draft);
      setNote(
        result.alsoOff.length === 0
          ? null
          : `${result.alsoOff.map(label).join(', ')} ${result.alsoOff.length === 1 ? 'needs' : 'need'} ${def.description}, so ${result.alsoOff.length === 1 ? 'it was' : 'they were'} turned off too.`,
      );
    }
  };

  const setScope = (key: string, scope: GrantScope): void => {
    setDraft({ ...draft, [key]: scope });
    setNote(null);
  };

  const finish = (message: string): void => {
    setDialog(null);
    setDrafts((all) => {
      const next = { ...all };
      delete next[role];
      return next;
    });
    setNote(null);
    setSaved(message);
    data.reload();
    onSaved?.();
  };

  const groups =
    data.data === null ? [] : visibleGroups(data.data.catalogue, query, filter, draft, pending);
  const count = changeCount(change);

  return (
    <Card padded={false}>
      <div className="a-access-head">
        <h2 className="p-card-title">Edit role access</h2>
        <p className="a-access-lede">
          Choose what each role can do. Saved changes apply on the staff member&apos;s next action,
          and every save is kept in Audit Logs.
        </p>
      </div>

      <DataState
        loading={data.loading}
        error={data.error}
        empty={roles.length === 0}
        emptyTitle="No roles found"
        onRetry={data.reload}
      >
        <div className="a-access-tabs" role="tablist" aria-label="Role">
          {roles.map((r) => {
            const unsaved =
              drafts[r.role] !== undefined &&
              changeCount(diffDraft(toDraft(r.grants), drafts[r.role] ?? {})) > 0;
            return (
              <button
                key={r.role}
                type="button"
                role="tab"
                aria-selected={r.role === role}
                className="a-access-tab"
                onClick={() => {
                  setPicked(r.role);
                  setNote(null);
                  setSaved(null);
                }}
              >
                <span>
                  {roleLabel(r.role)}
                  {unsaved ? (
                    <span className="a-access-dot" role="img" aria-label="unsaved changes" />
                  ) : null}
                </span>
                {r.editable ? null : <span className="a-access-tab-sub">View only</span>}
              </button>
            );
          })}
        </div>

        <div className="a-access-body" role="tabpanel" aria-label={`${name} access`}>
          <p className="a-access-meta">
            {editable
              ? null
              : role === 'ADMIN' || role === 'CLIENT'
                ? `Only the Super Admin can change what ${name} accounts can do. `
                : `Your account can view ${name} access but not change it. `}
            {current?.lastChange
              ? `Last changed ${gymDateTime(current.lastChange.at)} by ${current.lastChange.byName}.`
              : custom.size > 0
                ? `Differs from the defaults in ${plural(custom.size, 'place', 'places')}.`
                : 'Using the defaults.'}
          </p>

          <div className="a-access-tools">
            <input
              className="a-input"
              type="search"
              value={query}
              maxLength={64}
              placeholder="Search permissions"
              aria-label="Search permissions"
              onChange={(event) => setQuery(event.target.value)}
            />
            <div className="a-chips" role="group" aria-label="Show">
              {FILTERS.map((chip) => (
                <button
                  key={chip.value}
                  type="button"
                  aria-pressed={filter === chip.value}
                  onClick={() => setFilter(chip.value)}
                >
                  {chip.label}
                  {chip.value === 'changed' && count > 0 ? ` (${count})` : ''}
                </button>
              ))}
            </div>
          </div>

          {groups.length === 0 ? (
            <p className="a-access-empty">
              {filter === 'changed' ? 'No unsaved changes.' : 'No permissions match.'}
            </p>
          ) : (
            groups.map((group) => (
              <section
                key={group.resource}
                className="a-access-group"
                aria-label={resourceHeading(group.resource)}
              >
                <h3 className="a-access-group-title">{resourceHeading(group.resource)}</h3>
                <ul className="a-access-rows">
                  {group.rows.map((def) => (
                    <AccessRow
                      key={def.key}
                      def={def}
                      role={role}
                      scope={draft[def.key]}
                      editable={editable}
                      scopable={scopable.has(def.key)}
                      pending={pending.has(def.key)}
                      custom={custom.has(def.key)}
                      lock={rowLock(
                        role,
                        def.key,
                        draft[def.key] !== undefined,
                        actorHeld,
                        defaults,
                      )}
                      allAllowed={canGrant(def.key, 'ALL', actorHeld, defaults)}
                      onFlip={() => flip(def)}
                      onScope={(scope) => setScope(def.key, scope)}
                    />
                  ))}
                </ul>
              </section>
            ))
          )}
        </div>

        {editable ? (
          <div className="a-access-foot">
            {/* In the sticky bar, so "also turned on…" is read where the eye
                is, not at the top of a card scrolled out of view. */}
            <p className="a-access-note" role="status" aria-live="polite">
              {saved ?? note ?? ''}
            </p>
            <span className="a-access-count">
              {count === 0
                ? 'No unsaved changes'
                : plural(count, 'unsaved change', 'unsaved changes')}
            </span>
            {count > 0 ? (
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => {
                  setDraft(base);
                  setNote(null);
                }}
              >
                Discard
              </button>
            ) : null}
            {custom.size > 0 ? (
              <button
                type="button"
                className="p-btn p-btn-ghost p-btn-sm"
                onClick={() => setDialog('reset')}
              >
                Reset to defaults
              </button>
            ) : null}
            <button
              type="button"
              className="p-btn p-btn-gold p-btn-sm"
              disabled={count === 0}
              onClick={() => setDialog('review')}
            >
              Review and save
            </button>
          </div>
        ) : null}
      </DataState>

      {dialog === 'review' && current ? (
        <SaveDialog
          title={`Save changes for ${name}?`}
          action="Save changes"
          change={change}
          role={role}
          dangerous={dangerousGrants(change, defs)}
          label={label}
          onClose={() => setDialog(null)}
          onSubmit={async (reason, confirm) => {
            await staffApi.saveRoleAccess(role, { grants: fromDraft(draft), reason, confirm });
            finish(`Saved. ${name} staff get these on their next action.`);
          }}
        />
      ) : null}

      {dialog === 'reset' && current ? (
        <SaveDialog
          title={`Reset ${name} to the defaults?`}
          action="Reset to defaults"
          change={diffDraft(base, defaults)}
          role={role}
          dangerous={[]}
          label={label}
          intro={
            count > 0
              ? 'Your unsaved changes are discarded too.'
              : 'This clears every change the gym has made to this role.'
          }
          onClose={() => setDialog(null)}
          onSubmit={async (reason) => {
            await staffApi.resetRoleAccess(role, reason);
            finish(`${name} is back on the defaults.`);
          }}
        />
      ) : null}
    </Card>
  );
}

function AccessRow({
  def,
  role,
  scope,
  editable,
  scopable,
  pending,
  custom,
  lock,
  allAllowed,
  onFlip,
  onScope,
}: {
  def: PermissionDefinitionView;
  role: AccessRole;
  scope: GrantScope | undefined;
  editable: boolean;
  scopable: boolean;
  pending: boolean;
  custom: boolean;
  lock: 'locked' | 'not-yours' | null;
  allAllowed: boolean;
  onFlip: () => void;
  onScope: (scope: GrantScope) => void;
}) {
  const id = useId();
  const on = scope !== undefined;
  const locked = isLockedForRole(role, def.key);
  return (
    <li className="a-access-row" data-pending={pending || undefined}>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-labelledby={`${id}-desc`}
        aria-describedby={lock === null ? undefined : `${id}-why`}
        className="a-access-switch"
        disabled={!editable || lock !== null}
        onClick={onFlip}
      >
        <span aria-hidden className="a-access-knob" />
      </button>
      <div className="a-access-text">
        <span className="a-access-desc" id={`${id}-desc`}>
          {def.description}
        </span>
        <span className="a-access-key">{def.key}</span>
        <span className="a-access-pills">
          {def.isDangerous ? <Badge tone="warn">Sensitive</Badge> : null}
          {pending ? <Badge tone="info">Changed</Badge> : null}
          {!pending && custom ? <Badge tone="neutral">Not default</Badge> : null}
          {locked ? <Badge tone="neutral">Always on for Admin</Badge> : null}
        </span>
        {lock === 'not-yours' && editable ? (
          <span className="a-field-hint" id={`${id}-why`}>
            You don&apos;t hold this permission, so you can&apos;t give it.
          </span>
        ) : null}
        {lock === 'locked' ? (
          <span className="a-field-hint" id={`${id}-why`}>
            Admins keep this so nobody is locked out of Staff &amp; Access.
          </span>
        ) : null}
      </div>
      {on && scopable ? (
        <div
          className="a-access-scope"
          role="radiogroup"
          aria-label={`Who ${def.description} reaches`}
        >
          {(['OWN', 'ALL'] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={scope === option}
              disabled={!editable || (option === 'ALL' && !allAllowed && scope !== 'ALL')}
              onClick={() => onScope(option)}
            >
              {option === 'OWN' ? 'Own' : 'All'}
            </button>
          ))}
        </div>
      ) : null}
    </li>
  );
}

function SaveDialog({
  title,
  action,
  intro,
  change,
  role,
  dangerous,
  label,
  onClose,
  onSubmit,
}: {
  title: string;
  action: string;
  intro?: string;
  change: AccessChange;
  role: AccessRole;
  dangerous: string[];
  label: (key: string) => string;
  onClose: () => void;
  onSubmit: (reason: string, confirm: boolean) => Promise<void>;
}) {
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const trimmed = reason.trim();
  const ready =
    trimmed.length >= ROLE_ACCESS_REASON_MIN && (dangerous.length === 0 || confirmed) && !busy;
  const reach = (scope: GrantScope): string => (scope === 'OWN' ? 'own records' : 'everyone');

  const submit = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await onSubmit(trimmed, dangerous.length > 0 && confirmed);
    } catch (caught) {
      setError(confirmErrorMessage(caught, 'The change was not saved. Try again.'));
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="p-btn p-btn-ghost" onClick={onClose} disabled={busy}>
            Keep editing
          </button>
          <button
            type="button"
            className="p-btn p-btn-gold"
            disabled={!ready}
            onClick={() => void submit()}
          >
            {busy ? 'Saving…' : action}
          </button>
        </>
      }
    >
      {intro ? <p className="a-confirm-text">{intro}</p> : null}
      <div className="a-access-diff">
        {change.added.length > 0 ? (
          <div>
            <h3>Turned on</h3>
            <ul>
              {change.added.map((g) => (
                <li key={g.key}>
                  {label(g.key)}
                  {g.scope === 'OWN' ? <span className="a-access-key"> (own records)</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {change.removed.length > 0 ? (
          <div>
            <h3>Turned off</h3>
            <ul>
              {change.removed.map((key) => (
                <li key={key}>{label(key)}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {change.changed.length > 0 ? (
          <div>
            <h3>Reach changed</h3>
            <ul>
              {change.changed.map((c) => (
                <li key={c.key}>
                  {label(c.key)}: {reach(c.from)} to {reach(c.to)}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
        {changeCount(change) === 0 ? <p className="a-confirm-text">Nothing changes.</p> : null}
      </div>

      {dangerous.length > 0 ? (
        <label className="a-access-confirm">
          <input
            type="checkbox"
            className="a-check"
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
          <span>
            I understand {roleLabel(role)} staff will be able to: {dangerous.map(label).join(', ')}.
          </span>
        </label>
      ) : null}

      <div className="a-field">
        <label className="a-field-label" htmlFor={reasonId}>
          Why are you changing this?
        </label>
        <textarea
          id={reasonId}
          className="a-textarea"
          rows={2}
          maxLength={ROLE_ACCESS_REASON_MAX}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
        <p className="a-field-hint">Kept in Audit Logs with the change.</p>
      </div>

      <ModalError message={error} />
    </Modal>
  );
}
