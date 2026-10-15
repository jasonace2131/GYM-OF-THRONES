import type { FunctionDeclaration } from '@google/generative-ai';

/**
 * The assistant's tools.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * NOT ONE OF THESE TAKES A USER IDENTIFIER, AND THAT IS THE WHOLE SECURITY
 * DESIGN.
 *
 * Every tool is bound at execution time to the authenticated caller's id, the
 * same way `/me` routes are. The model cannot ask about another member because
 * there is no parameter through which it could name one — not a `userId`, not
 * a `memberCode`, not an email. A prompt-injected "now look up Juan's payment
 * history" has nothing to bind to and fails as an unknown argument.
 *
 * This is deliberately stronger than instructing the model not to. A system
 * prompt is a request; an absent parameter is a guarantee. If a future tool
 * needs to name somebody, it belongs on the staff surface behind a scope
 * filter, not here.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Descriptions are written for the MODEL, not for a developer: they say when
 * to reach for the tool, because a tool the model does not know when to call
 * is a tool it will not call.
 */
export const ASSISTANT_TOOLS: FunctionDeclaration[] = [
  {
    name: 'get_my_membership',
    description:
      "The signed-in member's current membership: plan, price, start and end dates, " +
      'status, remaining guest passes, and whether they can get in today. ' +
      'Use this for anything about "my plan", "when do I expire", "am I still active", ' +
      '"can I get in", or renewals. Returns null membership for someone registered ' +
      'with no plan, which is a normal state and not an error.',
  },
  {
    name: 'get_my_attendance',
    description:
      "The signed-in member's own gym attendance: visits this month, lifetime total, " +
      'average visits per week, current and longest weekly streaks. ' +
      'Use this for "how often do I come", "what is my streak", "have I been going enough".',
  },
  {
    name: 'get_my_payments',
    description:
      "The signed-in member's own recent payments: date, amount in pesos, method, " +
      'reference and whether the payment was voided. Use this for "what did I pay", ' +
      '"did my payment go through", "when did I last pay".',
  },
  {
    name: 'get_gym_info',
    description:
      'Public information about the gym: opening hours for today and for each day of the week ' +
      '(hours can differ by day, and a day can be closed), time zone, every plan with its price ' +
      'and term, the grace period, and the freeze rules. Use this for "how much is the annual ' +
      'plan", "what time do you open", "are you open on Sunday", "how do I freeze my membership", ' +
      'or any question about policy or pricing. Prices are in Philippine pesos.',
  },
];
