/**
 * The legal documents a member must accept, and the version of each.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ONE SOURCE OF TRUTH, SHARED, BECAUSE TWO WOULD DRIFT SILENTLY.
 *
 * The server writes this version into `ConsentRecord.version`; the client
 * renders the document and decides whether a member is behind. If those two
 * numbers could disagree — one hard-coded in a page, one in a service — the
 * failure is invisible: everyone appears to have consented to a version of
 * the text that nobody was ever shown.
 *
 * BUMPING A VERSION RE-PROMPTS EVERY MEMBER. That is the whole mechanism, and
 * it is why the value is a date rather than a counter: `2026-09-01` says when
 * the wording changed, which is the question a dispute actually asks. Bump it
 * for a change of substance — fees, liability, what data is processed. Do not
 * bump it for a typo, because a re-prompt spends member goodwill and teaches
 * people to click through without reading, which defeats the purpose.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const LEGAL_VERSIONS = {
  WAIVER: '2026-09-01',
  TERMS: '2026-09-01',
  PRIVACY: '2026-09-01',
} as const;

export type LegalDocumentKind = keyof typeof LEGAL_VERSIONS;

/** Every document a member must have accepted before the portal opens. */
export const REQUIRED_CONSENTS: readonly LegalDocumentKind[] = [
  'WAIVER',
  'TERMS',
  'PRIVACY',
] as const;

/** Route each kind renders at, so a link cannot point somewhere that 404s. */
export const LEGAL_ROUTES: Readonly<Record<LegalDocumentKind, string>> = {
  WAIVER: '/waiver',
  TERMS: '/terms',
  PRIVACY: '/privacy',
} as const;

/** Human label, for consent screens and the footer. */
export const LEGAL_LABELS: Readonly<Record<LegalDocumentKind, string>> = {
  WAIVER: 'Liability waiver',
  TERMS: 'Terms of membership',
  PRIVACY: 'Privacy notice',
} as const;
