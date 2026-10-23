// Barrel export — everything from @got/shared
export * from './types/user.types';
// Input rules: PH mobile phones, names, references, dates of birth.
export * from './validation/inputs';
export * from './types/time.types';
export * from './types/membership.types';
export * from './types/attendance.types';
export * from './types/announcement.types';
export * from './types/service.types';
export * from './types/api.types';
export * from './types/config.types';
export * from './types/classes.types';
// A member's own notices (the personal half of the portal bell).
export * from './types/member-notice.types';
export * from './constants/routes';
export * from './constants/codes';
export * from './constants/legal';
export * from './constants/classes';
export * from './constants/reports';
export * from './constants/permissions';
// Staff & Access: who may give which role to whom. Enforced by the API,
// offered by the console — one copy, two runtimes.
export * from './rbac/role-hierarchy';
export * from './types/staff.types';
// Counter sign-up: a staff-created member's setup link.
export * from './types/member-join.types';
// The emailed sign-in code: the two /auth/login-code responses.
export * from './types/login-code.types';
// The gym's equipment list, fed to the AI planners.
export * from './types/gym-equipment.types';
// The statutory money arithmetic, consumed by the server's payment writes and
// by the console's amend preview. One copy, two runtimes.
export * from './money/amounts';

// ── Rich-text announcements ──────────────────────────────────────────────
// The allowlist, URL rules and plain-text derivation the server enforces and
// the console's editor follows. One copy, two runtimes, like the money above.
export * from './announcements/rich-text';

// ── Coach tools (feat/coach-tools) ──
export * from './types/chat.types';
export * from './constants/chat';
// The workout-plan schema: the server checks the model's reply and every save
// with it, and the coach's editor checks with the same copy before Save.
export * from './coaching/workout-plan';

// ── Member workout planner (feat/member-workouts) ──
export * from './workouts/workouts.types';
export * from './workouts/member-plan';
export * from './workouts/sessions';
export * from './workouts/goal-suitability';
