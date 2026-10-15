import { readFileSync } from 'fs';
import { join } from 'path';
import { createClient } from '@supabase/supabase-js';
import { PrismaClient, Role } from '@prisma/client';

/**
 * Parses server/.env by hand. This script runs standalone via ts-node (not
 * `prisma db seed`, which loads .env automatically), so it has to load its
 * own env vars.
 */
function loadServerEnv(): Record<string, string> {
  const text = readFileSync(join(__dirname, '..', '.env'), 'utf8');
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

/**
 * A single shared password for every seeded role, so signing in as each one
 * while testing does not mean juggling five random strings.
 *
 * DEVELOPMENT ONLY. This value is committed, so it is public: anyone with the
 * repository knows it. It is safe here because these accounts exist on a
 * throwaway database with no real member data. Never point this script at a
 * deployment that matters — and if you ever do need to, set
 * SEED_ACCOUNT_PASSWORD in server/.env and this default is ignored.
 */
const DEFAULT_SEED_PASSWORD = 'Pass123!';

function generatePassword(env: Record<string, string>): string {
  const override = env['SEED_ACCOUNT_PASSWORD'];
  if (override !== undefined && override.length > 0) return override;
  return DEFAULT_SEED_PASSWORD;
}

interface RoleAccount {
  role: Role;
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * One personal test/demo account per role, plus-addressed off a single real
 * inbox. DEV is named "superadmin" in the address to match how it's talked
 * about day to day, even though the schema calls it DEV.
 */
const ROLE_ACCOUNTS: RoleAccount[] = [
  { role: 'CLIENT', email: 'ysa+client@test.com', firstName: 'Client', lastName: 'Test' },
  {
    role: 'FRONT_DESK',
    email: 'ysa+frontdesk@test.com',
    firstName: 'Front Desk',
    lastName: 'Test',
  },
  { role: 'COACH', email: 'ysa+coach@test.com', firstName: 'Coach', lastName: 'Test' },
  { role: 'ADMIN', email: 'ysa+admin@test.com', firstName: 'Admin', lastName: 'Test' },
  { role: 'DEV', email: 'ysa+superadmin@test.com', firstName: 'Super', lastName: 'Admin' },
];

type AdminApi = ReturnType<typeof createClient>['auth']['admin'];

async function findAuthUserByEmail(admin: AdminApi, email: string): Promise<{ id: string } | null> {
  let page = 1;
  const perPage = 200;
  for (;;) {
    const { data, error } = await admin.listUsers({ page, perPage });
    if (error) throw new Error(`listUsers failed: ${error.message}`);
    const found = data.users.find((u) => u.email === email);
    if (found) return { id: found.id };
    if (data.users.length < perPage) return null;
    page += 1;
  }
}

async function main(): Promise<void> {
  const env = loadServerEnv();
  const supabaseUrl = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY;
  if (!supabaseUrl || !serviceKey) {
    throw new Error('SUPABASE_URL / SUPABASE_SERVICE_KEY missing from server/.env');
  }

  const admin = createClient(supabaseUrl, serviceKey).auth.admin;
  const prisma = new PrismaClient();
  const credentials: Array<{ role: Role; email: string; password: string }> = [];

  try {
    for (const account of ROLE_ACCOUNTS) {
      const password = generatePassword(env);
      const metadata = { firstName: account.firstName, lastName: account.lastName };

      const existing = await findAuthUserByEmail(admin, account.email);
      let supabaseId: string;

      if (existing) {
        const { data, error } = await admin.updateUserById(existing.id, {
          password,
          email_confirm: true,
          user_metadata: metadata,
        });
        if (error) throw new Error(`updateUserById failed for ${account.email}: ${error.message}`);
        supabaseId = data.user.id;
      } else {
        const { data, error } = await admin.createUser({
          email: account.email,
          password,
          email_confirm: true,
          user_metadata: metadata,
        });
        if (error) throw new Error(`createUser failed for ${account.email}: ${error.message}`);
        supabaseId = data.user.id;
      }

      // Direct DB write, not the request-time JIT provisioning path — this is
      // exactly the "seed or direct DB access" the RBAC design reserves for
      // setting a role (see server/src/auth/user-provisioning.service.ts,
      // which deliberately never sets role from a token claim).
      await prisma.user.upsert({
        where: { supabaseId },
        create: {
          supabaseId,
          email: account.email,
          firstName: account.firstName,
          lastName: account.lastName,
          role: account.role,
          status: 'ACTIVE',
        },
        update: {
          email: account.email,
          firstName: account.firstName,
          lastName: account.lastName,
          role: account.role,
          status: 'ACTIVE',
        },
      });

      credentials.push({ role: account.role, email: account.email, password });
      console.info(`${existing ? 'Updated' : 'Created'} ${account.role} — ${account.email}`);
    }
  } finally {
    await prisma.$disconnect();
  }

  console.info('\nCredentials (shown once — not stored anywhere):');
  for (const c of credentials) {
    console.info(`  ${c.role.padEnd(10)} ${c.email}  ${c.password}`);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
