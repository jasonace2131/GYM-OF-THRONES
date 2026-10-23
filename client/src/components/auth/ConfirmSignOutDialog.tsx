'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import { AlertDialog as AlertDialogPrimitive } from 'radix-ui';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

/**
 * The one confirmation in front of every Sign out (owner, 2026-10-23: "1 click
 * for the signout is just not good"). Signing back in costs a password AND an
 * emailed code, so a mis-tap is expensive — the dialog says so.
 *
 * Built on the shadcn AlertDialog because tailwind.css is loaded by BOTH the
 * portal and the console layouts, and both provide a portal container, so the
 * dialog renders inside `.portal-root` with the tokens on either surface.
 * Radix gives focus on Cancel, a focus trap, Escape and focus return.
 *
 * The buttons are the surface's own `.p-btn` classes, NOT shadcn's Button:
 * the member portal confirms in ink, the console keeps its danger button.
 * No Tailwind classes are written in this file (it is outside the scanned
 * folders on purpose — see scripts/tailwind-containment.mjs).
 *
 * NOT used by the flows that sign out as part of another action — account
 * deletion, "Sign out and continue" on the invite/join wrong-account screens,
 * the login-code step's "use a different account", and the consent gate's
 * "Not now — sign me out". Each of those is already a deliberate choice.
 */

export type SignOutSurface = 'member' | 'admin';

const TOUCH: CSSProperties = { minHeight: 44 };

export interface ConfirmSignOutDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Runs the sign-out. The dialog stays up, disabled, until it settles. */
  onConfirm: () => void | Promise<void>;
  surface: SignOutSurface;
}

export function ConfirmSignOutDialog({
  open,
  onOpenChange,
  onConfirm,
  surface,
}: ConfirmSignOutDialogProps) {
  const [busy, setBusy] = useState(false);

  const confirm = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm();
    } finally {
      setBusy(false);
    }
  };

  return (
    <AlertDialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <AlertDialogContent size="sm">
        <AlertDialogHeader>
          <AlertDialogTitle>Sign out?</AlertDialogTitle>
          <AlertDialogDescription>
            You&apos;ll need your password and an emailed code to sign back in.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogPrimitive.Cancel className="p-btn p-btn-ghost" style={TOUCH} disabled={busy}>
            Cancel
          </AlertDialogPrimitive.Cancel>
          <AlertDialogPrimitive.Action
            className={surface === 'admin' ? 'p-btn p-btn-danger' : 'p-btn p-btn-dark'}
            style={TOUCH}
            disabled={busy}
            onClick={(event) => {
              // Keep the dialog up until the sign-out settles; the caller navigates.
              event.preventDefault();
              void confirm();
            }}
          >
            Sign out
          </AlertDialogPrimitive.Action>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export interface SignOutButtonProps {
  surface: SignOutSurface;
  onConfirm: () => void | Promise<void>;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}

/** A Sign out trigger that asks first. The trigger keeps the caller's own look. */
export function SignOutButton({
  surface,
  onConfirm,
  className,
  style,
  children,
}: SignOutButtonProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={className} style={style} onClick={() => setOpen(true)}>
        {children}
      </button>
      <ConfirmSignOutDialog
        open={open}
        onOpenChange={setOpen}
        onConfirm={onConfirm}
        surface={surface}
      />
    </>
  );
}
