/**
 * The widest window any report endpoint will answer.
 *
 * 366 is a year plus the leap day, so "this year versus last year" is one
 * call each rather than a stitched-together pair — the first comparison an
 * owner asks for, and the one a 90-day cap would make impossible.
 *
 * It is also a real memory bound, not a politeness. `walkInStats` does an
 * uncapped `findMany` over CheckIn and reduces in JS: without a cap on the
 * window, one request decides how much of the table lands in the Node heap,
 * and the request that does it is a typo in a date field.
 *
 * Counted the way `resolveDateWindow` counts: this is `civilDaysBetween(from,
 * to)`, the days BETWEEN the two inclusive bounds. from=1st, to=15th is 14.
 */
export const REPORT_MAX_RANGE_DAYS = 366;

/** How far back a report looks when the caller sends no window at all. */
export const REPORT_DEFAULT_RANGE_DAYS = 29;
