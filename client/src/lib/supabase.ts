'use client';

import { createClient } from '@supabase/supabase-js';

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Missing NEXT_PUBLIC_SUPABASE_URL or NEXT_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Copy .env.example to client/.env.local and fill in your Supabase project values.',
  );
}

/**
 * Browser Supabase client.
 *
 * Uses the ANON key, which is designed to be public and is safe in the bundle.
 * The service_role key bypasses Row Level Security and must never appear here.
 *
 * The session is persisted and refreshed automatically, so `getSession()` in
 * lib/api.ts returns a valid access token without the caller managing expiry.
 */
export const supabase = createClient(url, anonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});
