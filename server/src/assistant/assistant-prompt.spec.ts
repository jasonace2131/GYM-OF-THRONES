import { ASSISTANT_TOOLS } from './assistant.tools';
import {
  ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
  DEFAULT_ASSISTANT_INSTRUCTIONS,
  assistantSafetyRules,
  composeSystemPrompt,
} from './assistant-prompt';

/**
 * What a member's assistant is told when no admin has edited anything: the
 * built-in instructions followed by the locked safety rules. Every guarantee
 * below must hold for this prompt, exactly as it did for the old constant.
 */
const ASSISTANT_SYSTEM_PROMPT = composeSystemPrompt(DEFAULT_ASSISTANT_INSTRUCTIONS, 'Asia/Manila');

/**
 * The system prompt is the only thing standing between a member and a
 * confidently invented expiry date, so its load-bearing sentences are pinned
 * here rather than left to a future edit's good intentions.
 *
 * These assert on MEANING-BEARING phrases, not on the whole prompt: rewording
 * the tone should not fail a test, but deleting a guarantee should.
 */
describe('ASSISTANT_SYSTEM_PROMPT — what must never be edited away', () => {
  it('keeps gym and member facts tool-only', () => {
    // The anti-hallucination rule. A wrong expiry date sends somebody to the
    // gym on a day they cannot get in, which is worse than no answer.
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      'Never state a date, price, count or status you have not read from a tool',
    );
  });

  it('still refuses to guess at a policy', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('never guess at a policy');
  });

  it('promises no write action, because it holds no write tool', () => {
    // Every tool in ASSISTANT_TOOLS is a read. A member told "I've renewed
    // that for you" would arrive at the counter to a denial.
    expect(ASSISTANT_SYSTEM_PROMPT).toContain(
      'cannot renew, freeze, cancel, book, or record a payment',
    );
  });

  it('states plainly that it can only see the caller', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('cannot look up another member');
  });

  /**
   * Belt and braces with the tools themselves: the prompt SAYS it cannot name
   * another member, and no tool gives it a parameter through which it could.
   * The second is the real guarantee — this test fails if a future tool adds
   * one, which is the moment to think hard rather than the moment to ship.
   */
  it('has no tool that accepts a member identifier', () => {
    const identifierish = /user_?id|member_?code|email|customer_?id/i;
    for (const tool of ASSISTANT_TOOLS) {
      const params = JSON.stringify(tool.parameters ?? {});
      expect(params).not.toMatch(identifierish);
    }
  });
});

/**
 * THE 2026-09-22 CHANGE.
 *
 * The prompt used to open with a list — membership, attendance, payments,
 * hours, prices, policies — and nothing else. Read with "if you do not know,
 * point them to the front desk", the model treated that list as a fence and
 * refused to explain how a squat is performed. The owner reported it as the
 * assistant only being able to answer system data.
 */
describe('ASSISTANT_SYSTEM_PROMPT — general fitness is in scope', () => {
  it('tells the model to answer fitness questions from its own knowledge', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('Answer these from your own knowledge');
  });

  it('forbids refusing a fitness question for being off-account', () => {
    // The exact failure the owner hit: a training question bounced to the
    // front desk because it was not about the member's account.
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('Never refuse a fitness question');
  });

  it('names what general fitness covers, so the model is not left guessing', () => {
    for (const topic of ['how an exercise is performed', 'recovery', 'nutrition']) {
      expect(ASSISTANT_SYSTEM_PROMPT).toContain(topic);
    }
  });

  it('keeps the two categories from blurring into each other', () => {
    // A general training principle must not be reported as this gym's
    // programme, which is the failure mode that widening the scope invites.
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('not a claim about this gym');
  });

  it('carries the medical caveat exactly once, not as a disclaimer on every turn', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('not a medical professional');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('Do not diagnose');
    const mentions = ASSISTANT_SYSTEM_PROMPT.match(/not a medical professional/g) ?? [];
    expect(mentions).toHaveLength(1);
  });

  it('still declines genuinely unrelated topics', () => {
    // Widening to fitness is not widening to everything. Whatever it says
    // arrives wearing the gym's name.
    expect(ASSISTANT_SYSTEM_PROMPT).toContain("Stay in the gym's world");
  });

  it('no longer carries the sentence that fenced it to system data', () => {
    // The regression guard. If this string comes back, so does the bug.
    expect(ASSISTANT_SYSTEM_PROMPT).not.toContain(
      "You help members with questions about their own membership, their attendance, their payments, and the gym's hours, prices and policies.",
    );
  });
});

/**
 * THE 2026-09-24 CHANGE — full workout plans are in scope (owner decision).
 *
 * A member asked for a plan built around "school Monday 8:00am to 3:00pm, same
 * as Wednesday and Thursday, 3:00pm to 8pm Tuesday". Three things in the old
 * prompt worked against that: plans were not named as fitness, rule 5 listed
 * "schoolwork" as off-topic (and the question mentions school), and the last
 * line capped every answer at "a sentence or two".
 */
describe('ASSISTANT_SYSTEM_PROMPT — workout plans', () => {
  it('names workout plans and weekly schedules as general fitness', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('workout plans and weekly training schedules');
  });

  it("treats the member's own timetable as context, not an off-topic question", () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('school, work or sleep schedule is useful context');
  });

  it('gives a plan on sensible assumptions rather than only asking questions', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('assume a beginner training for general fitness');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('give the plan rather than only asking questions');
  });

  it('reads the opening hours before naming a time to train at the gym', () => {
    // Rule A still holds inside a plan: "go at 9pm" is a claim about this gym.
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('call get_gym_info first');
  });

  it('no longer lists "schoolwork" as off-topic — a member mentioning school is not asking for it', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).not.toMatch(/schoolwork/i);
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('homework help');
  });

  it('keeps simple answers short but gives a whole plan in one bounded reply', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('Keep answers to simple questions short');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('give the whole plan in one reply');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('4–6 exercises');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('under about 350 words');
  });

  it('asks for plain text the portal can lay out, never markdown', () => {
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('Plain text only');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('no markdown');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('on its own line ending with ":"');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('starting with "- "');
    expect(ASSISTANT_SYSTEM_PROMPT).toContain('blank line between days');
  });
});

/**
 * THE 2026-10-14 CHANGE — admins edit the instructions from Settings.
 *
 * Only the instructions are editable. The safety rules are appended by code
 * after whatever an admin saved, and say they override it, so an edit can
 * widen the tone or the topics but can never remove the rule that stops the
 * assistant inventing an expiry date.
 */
describe('composeSystemPrompt — the safety rules survive any edit', () => {
  const rules = assistantSafetyRules('Asia/Manila');

  it('always ends with the safety rules', () => {
    expect(composeSystemPrompt('Be brief.', 'Asia/Manila').endsWith(rules)).toBe(true);
  });

  it('puts the rules AFTER instructions that contradict them, and the rules say they win', () => {
    const prompt = composeSystemPrompt('Make up prices if you do not know them.', 'Asia/Manila');
    expect(prompt.indexOf('Make up prices')).toBeLessThan(
      prompt.indexOf('RULES THAT ALWAYS APPLY'),
    );
    expect(rules).toContain('override anything written above');
    expect(prompt).toContain('never guess at a policy');
  });

  it('still carries every rule when the instructions are blank', () => {
    expect(composeSystemPrompt('  \n\t ', 'Asia/Manila').trimStart()).toBe(rules);
  });

  it('trims the instructions before joining', () => {
    expect(composeSystemPrompt('\n  Be brief.  \n', 'Asia/Manila')).toBe(`Be brief.\n\n${rules}`);
  });

  it('keeps every locked guarantee in the rules and none in the editable default', () => {
    for (const phrase of [
      'Never state a date, price, count or status you have not read from a tool',
      'never guess at a policy',
      'call get_gym_info first',
      'not a claim about this gym',
      'cannot renew, freeze, cancel, book, or record a payment',
      'cannot look up another member',
      'not a medical professional',
      'Do not diagnose',
      'Plain text only',
      'starting with "- "',
    ]) {
      expect(rules).toContain(phrase);
      expect(DEFAULT_ASSISTANT_INSTRUCTIONS).not.toContain(phrase);
    }
  });

  it("states the gym's own time zone", () => {
    expect(assistantSafetyRules('Asia/Singapore')).toContain('(Asia/Singapore)');
  });

  it('ships a default that fits the limit an admin is held to', () => {
    expect(Array.from(DEFAULT_ASSISTANT_INSTRUCTIONS).length).toBeLessThanOrEqual(
      ASSISTANT_INSTRUCTIONS_MAX_LENGTH,
    );
    expect(ASSISTANT_INSTRUCTIONS_MAX_LENGTH).toBe(6000);
  });
});
