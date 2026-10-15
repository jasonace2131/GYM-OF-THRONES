/**
 * Whether "Ask the Gym" can be used right now, and what the page says if not.
 *
 * THE BUG THIS FIXES. `GET /me/assistant/status` is gated on `ai.chat.use`, and
 * the page mapped EVERY failure to `enabled: false` — so staff without the key
 * (a 403), and anyone whose network blinked, were told the assistant "is not
 * switched on" when it was on. Three different facts now get three sentences.
 */
export type AssistantAvailability = 'on' | 'off' | 'forbidden' | 'unreachable';

export function availabilityFromStatus(status: { enabled: boolean }): AssistantAvailability {
  return status.enabled ? 'on' : 'off';
}

/**
 * Structural rather than `instanceof ApiError`, for the reason `errors.ts`
 * gives: importing lib/api pulls in the Supabase client.
 */
export function availabilityFromError(caught: unknown): AssistantAvailability {
  const status =
    caught instanceof Error && caught.name === 'ApiError'
      ? (caught as { status?: unknown }).status
      : undefined;
  return status === 403 ? 'forbidden' : 'unreachable';
}

export interface AvailabilityCopy {
  title: string;
  hint: string;
  /** Whether trying again could help. */
  retry: boolean;
}

export function availabilityCopy(state: Exclude<AssistantAvailability, 'on'>): AvailabilityCopy {
  switch (state) {
    case 'off':
      return {
        title: 'The assistant is not switched on',
        hint: 'Ask at the front desk — they can answer anything it would have.',
        retry: false,
      };
    case 'forbidden':
      return {
        title: "The assistant isn't available for your account",
        hint: "It answers members' questions about their own membership. The front desk can help with anything else.",
        retry: false,
      };
    case 'unreachable':
      return {
        title: 'Could not reach the assistant',
        hint: 'This is usually the network. Check your connection and try again.',
        retry: true,
      };
  }
}
