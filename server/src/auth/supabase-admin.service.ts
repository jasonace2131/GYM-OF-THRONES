import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { DomainException } from '../common/exceptions/domain.exception';
import type { Env } from '../config/env.validation';

/**
 * Wraps the Supabase Auth admin API — the only place this codebase mints a
 * real Supabase user for a member `User` row (`createAuthUser`, no link: the
 * member's way in is our setup link, `MemberJoinService`).
 *
 * `User.supabaseId` is non-nullable (see the C2 brief and
 * `membership-import.service.ts:140`, which fabricates a UUID for legacy rows
 * and accepts that those accounts can never log in). Admin-created members
 * are not legacy rows, so creation must go through here.
 *
 * `SUPABASE_SERVICE_KEY` bypasses Row Level Security entirely — server-only,
 * never a `NEXT_PUBLIC_*` var — and OPTIONAL, same warn-and-disable spirit as
 * `GEMINI_API_KEY` in `AssistantService`: the gym must still boot without it,
 * and only member CREATION (with the email correction and the setup page's
 * sign-in link) is gated on it, not the whole server.
 */
@Injectable()
export class SupabaseAdminService {
  private readonly logger = new Logger(SupabaseAdminService.name);
  private readonly client: SupabaseClient | null;

  constructor(config: ConfigService<Env, true>) {
    const url = config.get('SUPABASE_URL', { infer: true });
    const key = config.get('SUPABASE_SERVICE_KEY', { infer: true });

    this.client =
      key === undefined
        ? null
        : createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

    if (this.client === null) {
      this.logger.warn('SUPABASE_SERVICE_KEY unset — member creation is disabled');
    }
  }

  get enabled(): boolean {
    return this.client !== null;
  }

  /**
   * Compensating delete for a mint that has nothing pointing at it.
   *
   * `MembersService.create` mints the Supabase identity BEFORE the local
   * `User` row (supabaseId is non-nullable, so it has no choice), which means
   * a failed local create strands an auth user forever — and, worse, one that
   * makes every later create for that email fail "already been registered".
   * This is that undo. Called best-effort from a catch, so it THROWS rather
   * than swallowing: the caller decides what a cleanup failure is worth, and
   * in `create`'s case that is an error-level log naming the orphaned id.
   */
  async deleteUser(userId: string): Promise<void> {
    if (this.client === null) {
      throw new DomainException(
        'MEMBER_CREATE_DISABLED',
        'Member creation is disabled: SUPABASE_SERVICE_KEY is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const { error } = await this.client.auth.admin.deleteUser(userId);
    if (error) {
      throw new DomainException(
        'MEMBER_INVITE_FAILED',
        `Could not delete the Supabase auth user: ${error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }
  }

  /**
   * Staff & Access: the invite page's "Set up my account".
   *
   * ─────────────────────────────────────────────────────────────────────────
   * A LINK FOR A NEW ACCOUNT ONLY — NEVER FOR AN EXISTING ONE.
   *
   * The caller is anonymous and holds nothing but an invitation token, and
   * the admin who issued the invitation has seen that token too (the console
   * shows the link once, to copy). An `invite` link for an address Supabase
   * has never seen creates an empty account, and whoever follows it is
   * setting that account up — nothing to take over. A `magiclink` for an
   * address that ALREADY has an account would be a signed-in session as that
   * person, handed to anyone holding the token: an admin could invite a member
   * and sign in as them. So an existing address gets `EXISTING_ACCOUNT` and
   * no link, and the invite page asks them to sign in the ordinary way.
   * ─────────────────────────────────────────────────────────────────────────
   *
   * `redirectTo` must be allowed in Supabase Auth → URL configuration →
   * Redirect URLs (`https://<site>/invite/*`), or Supabase refuses it.
   */
  async staffInviteAccountLink(
    email: string,
    redirectTo: string,
  ): Promise<{ kind: 'NEW_ACCOUNT'; actionLink: string } | { kind: 'EXISTING_ACCOUNT' }> {
    if (this.client === null) {
      throw new DomainException(
        'STAFF_INVITE_DISABLED',
        'Staff invitations are disabled: SUPABASE_SERVICE_KEY is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const { data, error } = await this.client.auth.admin.generateLink({
      type: 'invite',
      email,
      options: { redirectTo },
    });

    if (error) {
      if (isAlreadyRegistered(error)) return { kind: 'EXISTING_ACCOUNT' };
      throw new DomainException(
        'MEMBER_INVITE_FAILED',
        `Could not generate a Supabase auth link: ${error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
    }

    return { kind: 'NEW_ACCOUNT', actionLink: data.properties.action_link };
  }

  /**
   * Counter sign-up: the Supabase identity for a member created at the desk.
   *
   * No link is minted here. The member's way in is OUR setup link
   * (`MemberJoinService`), which lasts 7 days and only asks Supabase for a
   * sign-in link when the member presses "Set up my account" — a raw Supabase
   * link would expire in an hour and can be used up by a mail scanner.
   * Unconfirmed until that first sign-in proves the address.
   */
  async createAuthUser(email: string): Promise<{ userId: string }> {
    const client = this.requireClient();
    const { data, error } = await client.auth.admin.createUser({ email, email_confirm: false });
    if (error) throw toMemberAuthError(error);
    return { userId: data.user.id };
  }

  /**
   * The setup page's "Set up my account": a sign-in link for an EXISTING account.
   *
   * Unlike `staffInviteAccountLink`, minting a magic link for an existing account
   * is the point here, and safe because of what `MemberJoinService.claimLink`
   * enforces first: a `CLIENT` account, holding an unused, unexpired token that
   * was only ever sent to this address — and, after this returns, that the link
   * signs into that member's own Supabase account (`userId`), nobody else's. It
   * does NOT require that they have never signed in: a member who signed in
   * mid-setup can come back through the same link to finish (by design — it is
   * their own inbox, and no stronger than a password-reset email). The same
   * trust as a Supabase magic link, started by a button press instead of an
   * email a scanner can pre-fetch.
   *
   * A public route, so Supabase's own error text goes to the log, not the caller.
   *
   * `redirectTo` must be allowed in Supabase Auth → URL configuration →
   * Redirect URLs (`https://<site>/join/*`), or Supabase falls back to the
   * Site URL and the member never sees the password step.
   */
  async memberJoinSignInLink(
    email: string,
    redirectTo: string,
  ): Promise<{ actionLink: string; userId: string }> {
    const client = this.requireClient();
    const { data, error } = await client.auth.admin.generateLink({
      type: 'magiclink',
      email,
      options: { redirectTo },
    });
    if (error) {
      this.logger.warn(`Setup sign-in link refused by Supabase: ${error.message}`);
      throw new DomainException(
        'MEMBER_INVITE_FAILED',
        'Could not start account set-up. Try again in a moment.',
        HttpStatus.BAD_GATEWAY,
      );
    }
    return { actionLink: data.properties.action_link, userId: data.user.id };
  }

  /** Correcting a mistyped address on a never-signed-in member. */
  async updateAuthEmail(supabaseId: string, email: string): Promise<void> {
    const client = this.requireClient();
    const { error } = await client.auth.admin.updateUserById(supabaseId, { email });
    if (error) throw toMemberAuthError(error);
  }

  private requireClient(): SupabaseClient {
    if (this.client === null) {
      throw new DomainException(
        'MEMBER_CREATE_DISABLED',
        'Member creation is disabled: SUPABASE_SERVICE_KEY is not configured.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
    return this.client;
  }
}

/**
 * A substring match on Supabase's error MESSAGE text, not a stable error
 * code — GoTrue does not expose one for this case. Fragile by construction:
 * a Supabase wording change silently drops this branch to the generic
 * `MEMBER_INVITE_FAILED` (502) instead of `MEMBER_EMAIL_TAKEN` (409), rather
 * than throwing outright, so it fails toward "user sees a less specific
 * error" and not toward a crash. Worth re-checking against the live API on
 * any `@supabase/supabase-js` upgrade.
 */
function isAlreadyRegistered(error: { message: string }): boolean {
  return error.message.toLowerCase().includes('already been registered');
}

/** "Already registered" is the caller's 409; anything else is Supabase's 502. */
function toMemberAuthError(error: { message: string }): DomainException {
  return isAlreadyRegistered(error)
    ? new DomainException(
        'MEMBER_EMAIL_TAKEN',
        'A member with this email already exists.',
        HttpStatus.CONFLICT,
      )
    : new DomainException(
        'MEMBER_INVITE_FAILED',
        `Supabase refused the request: ${error.message}`,
        HttpStatus.BAD_GATEWAY,
      );
}
