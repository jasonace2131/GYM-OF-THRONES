'use client';

import { useCallback, useRef, useState } from 'react';
import { adminApi, type MemberListItem } from '@/lib/adminApi';
import { useAdminQuery, useDebounced } from '@/lib/useAdminQuery';
import { Person } from './ui';

/**
 * "Find a member", lifted out of `admin/members/page.tsx`.
 *
 * That page already had every hard part working — a debounced `type="search"`
 * box over `adminApi.members({ search })`, with `useAdminQuery` dropping
 * out-of-order responses so the list can never settle on results for a prefix
 * of what the box now reads. Two modals needed the same thing, and the choice
 * was to write it a second time or to lift it once. Its search covers name,
 * member code, email and phone, which is inherited rather than re-specified.
 *
 * What a PICKER needs that a LIST PAGE does not, and all this file really
 * adds: keyboard selection, a chosen-member chip, and `onSelect`.
 *
 * It deliberately does NOT own fetching, debouncing, or types — those stay in
 * `adminApi` and `useAdminQuery`, so there is one search behaviour in the
 * product rather than two that drift apart.
 */

const RESULT_LIMIT = 6;

export interface MemberPickerProps {
  value: MemberListItem | null;
  onSelect: (member: MemberListItem | null) => void;
  label?: string;
  /** Rendered when nothing is chosen yet. */
  placeholder?: string;
  autoFocus?: boolean;
}

export function MemberPicker({
  value,
  onSelect,
  label = 'Member',
  placeholder = 'Search name, member code, email or phone…',
  autoFocus = false,
}: MemberPickerProps) {
  const [search, setSearch] = useState('');
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const debounced = useDebounced(search);
  const enabled = debounced.trim().length >= 2;

  const query = useAdminQuery(
    useCallback(
      () =>
        enabled
          ? adminApi.members({ limit: RESULT_LIMIT, search: debounced.trim() })
          : Promise.resolve(null),
      [debounced, enabled],
    ),
    `member-picker:${enabled ? debounced.trim() : ''}`,
  );

  const results = query.data?.items ?? [];

  const choose = (member: MemberListItem): void => {
    onSelect(member);
    setSearch('');
    setOpen(false);
    setActive(0);
  };

  const clear = (): void => {
    onSelect(null);
    setSearch('');
    setOpen(false);
    setActive(0);
    inputRef.current?.focus();
  };

  // A chosen member replaces the input entirely. Leaving the box in place
  // beside a selection makes it ambiguous which one the form will submit.
  if (value !== null) {
    return (
      <div className="a-field">
        <span className="a-field-label">{label}</span>
        <div className="a-picked">
          <Person
            firstName={value.firstName}
            lastName={value.lastName}
            sub={value.memberCode ?? value.email}
            avatarUrl={value.avatarUrl}
          />
          <button type="button" className="a-picked-x" onClick={clear}>
            Change
          </button>
        </div>
      </div>
    );
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (results.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setActive((i) => (i + 1) % results.length);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((i) => (i - 1 + results.length) % results.length);
    } else if (event.key === 'Enter') {
      // The picker sits inside a form; Enter here means "take this member",
      // never "submit with no member chosen".
      event.preventDefault();
      const picked = results[active];
      if (picked !== undefined) choose(picked);
    } else if (event.key === 'Escape' && open) {
      // Swallowed so the surrounding Modal does not also close.
      event.stopPropagation();
      setOpen(false);
    }
  };

  return (
    <div className="a-field">
      <label className="a-field-label" htmlFor="member-picker-input">
        {label}
      </label>
      <div className="a-picker">
        <input
          id="member-picker-input"
          ref={inputRef}
          className="a-input"
          type="search"
          maxLength={64}
          role="combobox"
          aria-expanded={open && results.length > 0}
          aria-controls="member-picker-list"
          aria-autocomplete="list"
          autoComplete="off"
          autoFocus={autoFocus}
          value={search}
          placeholder={placeholder}
          onChange={(event) => {
            setSearch(event.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={onKeyDown}
        />

        {open && enabled && (
          <ul className="a-picker-list" id="member-picker-list" role="listbox">
            {query.loading && <li className="a-picker-note">Searching…</li>}

            {!query.loading && results.length === 0 && (
              <li className="a-picker-note">No member matches “{debounced.trim()}”.</li>
            )}

            {results.map((member, index) => (
              <li key={member.userId} role="option" aria-selected={index === active}>
                <button
                  type="button"
                  className="a-picker-row"
                  data-active={index === active}
                  // mousedown, not click: the input's blur would otherwise
                  // close the list before the click ever lands.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    choose(member);
                  }}
                  onMouseEnter={() => setActive(index)}
                >
                  <Person
                    firstName={member.firstName}
                    lastName={member.lastName}
                    sub={member.memberCode ?? member.email}
                    avatarUrl={member.avatarUrl}
                  />
                </button>
              </li>
            ))}
          </ul>
        )}

        {open && !enabled && search.length > 0 && (
          <ul className="a-picker-list">
            <li className="a-picker-note">Keep typing — at least two characters.</li>
          </ul>
        )}
      </div>
    </div>
  );
}
