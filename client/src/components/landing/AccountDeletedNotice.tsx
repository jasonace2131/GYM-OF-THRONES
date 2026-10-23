'use client';

import { useEffect, useState } from 'react';
import { ACCOUNT_DELETED_FLAG, ACCOUNT_DELETED_NOTICE } from '@/lib/accountDeleted';

/**
 * The one line a member sees on the home page after deleting their account
 * (My account → Delete account). Read once from sessionStorage and cleared,
 * so a reload or a later visit shows nothing. Renders nothing on the server,
 * in a private window with storage blocked, or for everybody else.
 */
export function AccountDeletedNotice() {
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(ACCOUNT_DELETED_FLAG) === null) return;
      window.sessionStorage.removeItem(ACCOUNT_DELETED_FLAG);
      setShow(true);
    } catch {
      // Storage blocked: nothing to show.
    }
  }, []);

  if (!show) return null;
  return (
    <div
      role="status"
      style={{
        position: 'fixed',
        top: 'calc(80px + env(safe-area-inset-top, 0px))',
        left: 16,
        right: 16,
        zIndex: 60,
        margin: '0 auto',
        maxWidth: 480,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '10px 10px 10px 16px',
        borderRadius: 12,
        background: '#16130f',
        color: '#f2eee6',
        border: '1px solid rgba(201, 146, 42, 0.45)',
        fontSize: 14,
      }}
    >
      <span style={{ flex: 1 }}>{ACCOUNT_DELETED_NOTICE}</span>
      <button
        type="button"
        onClick={() => setShow(false)}
        aria-label="Dismiss"
        style={{
          minWidth: 44,
          minHeight: 44,
          border: 0,
          borderRadius: 8,
          background: 'transparent',
          color: 'inherit',
          fontSize: 18,
          cursor: 'pointer',
        }}
      >
        ×
      </button>
    </div>
  );
}
