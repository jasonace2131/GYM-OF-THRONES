import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Resend } from 'resend';
import type { Env } from '../config/env.validation';

/**
 * Outbound transactional email, on Resend: the counter sign-up "account is
 * ready" email with the member's setup link, staff invitations, and the
 * website-enquiry notification.
 *
 * `RESEND_API_KEY` and `RESEND_FROM` are both OPTIONAL — unset is a
 * SUPPORTED state, not a boot failure, exactly like `GEMINI_API_KEY` in
 * `AssistantService` (assistant.service.ts:68): the gym must be able to run
 * without an email bill, and the rest of the API has no business refusing to
 * start because outbound mail is unconfigured.
 *
 * Unlike the assistant's routes (which 503 while disabled), a disabled
 * EmailService does not fail the request it is called from: `sendMemberJoin`
 * throws, and `MemberJoinService.issue` catches that and reports
 * `emailSent: false` — the member row and their setup link already exist by
 * the time this runs, so a mail outage is never a reason to lose them.
 */
@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly client: Resend | null;
  private readonly from: string | null;

  constructor(config: ConfigService<Env, true>) {
    const apiKey = config.get('RESEND_API_KEY', { infer: true });
    const from = config.get('RESEND_FROM', { infer: true });

    this.client = apiKey === undefined ? null : new Resend(apiKey);
    this.from = from ?? null;

    if (this.client === null || this.from === null) {
      this.logger.warn(
        'RESEND_API_KEY and/or RESEND_FROM unset — outbound email is disabled',
      );
    }
  }

  get enabled(): boolean {
    return this.client !== null && this.from !== null;
  }

  /**
   * Counter sign-up: "your account is ready", with OUR setup link — 7 days,
   * single use — and, when the member has a current plan, what it is and until
   * when. Throws on any failure; `MemberJoinService.issue` catches and reports
   * `emailSent: false`, because the account and the link already exist.
   */
  async sendMemberJoin(
    to: string,
    input: { name: string; link: string; plan: { name: string; endsOn: string } | null },
  ): Promise<void> {
    if (this.client === null || this.from === null) {
      throw new Error('EmailService is disabled: RESEND_API_KEY / RESEND_FROM not configured.');
    }

    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: 'Your Gym of Thrones account is ready',
      html: memberJoinHtml(input),
    });

    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }

  /**
   * Staff & Access: an invitation to join the staff.
   *
   * The link is OUR invite page (`/invite/<token>`), never a Supabase auth
   * link. Supabase's links expire in an hour and a mail scanner that
   * pre-fetches one uses it up; the invite page lives the invitation's full
   * seven days and only mints an account link when a person clicks.
   *
   * Throws like `sendMemberJoin`, and the invitations service catches: the
   * invitation row is committed first, and the console shows the link to
   * copy whether or not this email went.
   */
  async sendStaffInvite(
    to: string,
    invite: { roleLabel: string; inviterName: string; link: string },
  ): Promise<void> {
    if (this.client === null || this.from === null) {
      throw new Error('EmailService is disabled: RESEND_API_KEY / RESEND_FROM not configured.');
    }

    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: `You're invited to join Gym of Thrones as ${invite.roleLabel}`,
      html: staffInviteHtml(invite),
    });

    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }

  /**
   * The emailed sign-in code: the second step after the password, on every
   * sign-in. Throws like the others; `LoginCodeService.send` catches, un-counts
   * the send and answers 503 LOGIN_CODE_EMAIL_FAILED.
   */
  async sendLoginCode(to: string, input: { name: string; code: string }): Promise<void> {
    if (this.client === null || this.from === null) {
      throw new Error('EmailService is disabled: RESEND_API_KEY / RESEND_FROM not configured.');
    }

    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      subject: `Your Gym of Thrones sign-in code: ${input.code}`,
      html: loginCodeHtml(input),
    });

    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }

  /**
   * Tell the gym somebody enquired.
   *
   * Throws like `sendMemberJoin`, and `ContactService` catches — the lead is
   * committed before this is called, so a Resend outage costs a notification
   * and never the enquiry.
   *
   * `replyTo` is the point of the whole message: staff hit reply and are
   * talking to the person, rather than to the gym's own sending address.
   */
  async sendLeadNotification(
    to: string,
    lead: { name: string; email: string | null; phone: string | null; message: string | null },
  ): Promise<void> {
    if (this.client === null || this.from === null) {
      throw new Error('EmailService is disabled: RESEND_API_KEY / RESEND_FROM not configured.');
    }

    const { error } = await this.client.emails.send({
      from: this.from,
      to,
      // The name is in the subject so a full inbox is still triageable.
      subject: `New enquiry — ${lead.name}`,
      ...(lead.email === null ? {} : { replyTo: lead.email }),
      html: leadHtml(lead),
    });

    if (error) {
      throw new Error(`Resend send failed: ${error.message}`);
    }
  }
}

/**
 * EVERY FIELD HERE IS ATTACKER-CONTROLLED.
 *
 * This is the only email in the system built from an anonymous stranger's
 * input, so every interpolation is escaped — including the phone number,
 * which looks numeric and is a free-text column.
 */
/** Split out so the literal is never adjacent to a template newline. */
const NEWLINES = new RegExp(String.fromCharCode(10), 'g');

function leadHtml(lead: {
  name: string;
  email: string | null;
  phone: string | null;
  message: string | null;
}): string {
  const rows = [
    `<p><strong>Name:</strong> ${escapeHtml(lead.name)}</p>`,
    lead.email === null
      ? ''
      : `<p><strong>Email:</strong> <a href="mailto:${escapeAttribute(lead.email)}">${escapeHtml(lead.email)}</a></p>`,
    lead.phone === null ? '' : `<p><strong>Phone:</strong> ${escapeHtml(lead.phone)}</p>`,
    lead.message === null
      ? ''
      : `<p><strong>Message:</strong></p><p>${escapeHtml(lead.message).replace(NEWLINES, '<br />')}</p>`,
  ];

  return (
    `<p>Somebody enquired through the website.</p>${rows.join('')}` +
    `<p style="color:#888;font-size:12px">This enquiry is also saved in the admin console under Leads.</p>`
  );
}

function staffInviteHtml(invite: { roleLabel: string; inviterName: string; link: string }): string {
  return (
    `<p>${escapeHtml(invite.inviterName)} has invited you to join Gym of Thrones as ` +
    `<strong>${escapeHtml(invite.roleLabel)}</strong>.</p>` +
    `<p><a href="${escapeAttribute(invite.link)}">Accept your invitation</a></p>` +
    `<p>The link works for 7 days. If you did not expect this, you can ignore this email.</p>`
  );
}

/** The expiry sentence is literal HTML: escapeHtml would turn its apostrophe into `&#39;`. */
function loginCodeHtml(input: { name: string; code: string }): string {
  return (
    `<p>Hi ${escapeHtml(input.name)}, here is your Gym of Thrones sign-in code:</p>` +
    `<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:16px 0">${escapeHtml(input.code)}</p>` +
    `<p>It expires in 10 minutes. If you didn't try to sign in, change your password.</p>`
  );
}

function memberJoinHtml(input: {
  name: string;
  link: string;
  plan: { name: string; endsOn: string } | null;
}): string {
  const plan =
    input.plan === null
      ? ''
      : `<p>Your ${escapeHtml(input.plan.name)} plan runs until ${escapeHtml(input.plan.endsOn)}.</p>`;
  return (
    `<p>Hi ${escapeHtml(input.name)}, your account at Gym of Thrones is ready.</p>` +
    plan +
    `<p><a href="${escapeAttribute(input.link)}">Set up my account</a></p>` +
    `<p>This link works once and expires in 7 days. If it has expired, ask the front desk for a new one.</p>`
  );
}

/**
 * A double-quoted HTML ATTRIBUTE value, not element text.
 *
 * A link interpolated raw into `href="..."` lets a single `"` anywhere in it
 * — in a token, or a redirect URL carrying one — close the attribute early and
 * the rest of the value be parsed as further markup. `&` is escaped first
 * (order matters, or the escapes below get double-escaped), and `<`/`>` are
 * covered too so a mangled link cannot open a tag either.
 */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/** The name is staff-typed free text, so it lands in an HTML email verbatim otherwise. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
