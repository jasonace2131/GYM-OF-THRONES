import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Guard registration order is load-bearing: AuthGuard must attach
 * `request.user` before UserThrottlerGuard can key on it, and a throttled
 * request must never reach PermissionsGuard's permission cache.
 *
 * This asserts on the source text rather than importing AppModule at runtime.
 * Importing it here would pull in HealthModule, which imports
 * `./health.controller.js` with an explicit `.js` extension — a pre-existing
 * resolution gap in this project's unit-test jest config (also reproducible
 * on the untouched `test/app.e2e-spec.ts` template, unrelated to this task).
 * A static check is what stays reliable without depending on that being fixed.
 *
 * The `provide: APP_GUARD` and `useClass: X` pair is matched as ONE unit via
 * regex, not as two independently-findable substrings — otherwise commenting
 * out a whole registration line, or an unrelated `useClass: X` provider
 * elsewhere in the file, would still satisfy a naive ordering check. Comment
 * lines are stripped first so a disabled registration can never match.
 */
describe('AppModule guard registration order', () => {
  it('registers AuthGuard, then UserThrottlerGuard, then PermissionsGuard as APP_GUARD providers', () => {
    const rawSource = readFileSync(join(__dirname, 'app.module.ts'), 'utf-8');

    // Drop full-line `//` comments so a disabled registration cannot match.
    const source = rawSource
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

    const guardProviderPattern = /\{\s*provide:\s*APP_GUARD\s*,\s*useClass:\s*(\w+)\s*\}/g;

    const registeredGuards = [...source.matchAll(guardProviderPattern)].map((match) => match[1]);

    expect(registeredGuards).toEqual(['AuthGuard', 'UserThrottlerGuard', 'PermissionsGuard']);
  });
});
