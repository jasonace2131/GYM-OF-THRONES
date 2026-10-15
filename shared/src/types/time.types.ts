// The one definition of a gym-local civil date.
//
// Branded so a bare string cannot be passed where a business day is meant.
// Both gym-time modules (server/src/common/time/gym-time.ts and
// client/src/lib/gymTime.ts) re-export this type rather than redeclaring it:
// a second `unique symbol` brand would be a different, incompatible type and
// the two runtimes would stop agreeing at the package boundary.

/** A gym-local calendar date in 'yyyy-mm-dd' form. Never an instant. */
export type CivilDate = string & { readonly __civil: unique symbol };
