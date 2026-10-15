# Uptime pinger

A Cloudflare Worker that checks the API on a schedule and messages you on
Telegram when it goes down.

- **06:00–23:00 Manila, every 10 min.** Keeps Render's free instance awake, so
  nobody at the counter waits through a ~50s cold start.
- **03:00–04:00 Manila, every 10 min.** The API runs two jobs in-process at
  03:15 (membership nightly) and 03:30 (cleanup), and a sleeping instance
  runs neither.
- **The rest of the night, hourly.** Alert-only, and lets Render sleep. Awake
  around the clock would use ~744 of Render's 750 free hours a month. This
  schedule uses about 600.
- **It checks the member path:** `www.gym-of-thrones.site/api/health`, through
  the Vercel proxy, which is what a member's phone actually depends on. When
  that fails, it also asks Render directly, so the alert says which leg broke.
- **It messages once when the API breaks**, every 30 minutes while it stays
  down, and once when it recovers. It never messages on every check.
- **A single miss is not an outage.** Each check retries once, because the
  first check after a quiet night can land on a sleeping instance.

Telegram bots can send messages but **cannot place calls**. Give the chat a
loud custom notification sound if you want it to cut through.

## /check

Type `/check` in the staff group (or tap it from the `/` menu) and the bot
probes the site right then: 🟢 online with how long it took, or 🔴 which leg
failed. It only answers in the configured group, and it never changes the
state the scheduled alerts keep. `/help` explains the bot.

If the API is asleep, `/check` wakes it up. The reply may say "try again in
a minute", because a cold start takes longer than a reply can wait.

## /redeploy

`/redeploy` (or `/restart`) starts a fresh Render deploy of the API. Use it
when the site is **stuck**, not just asleep: a ping wakes a sleeping
instance, but only a deploy replaces one that has stopped answering. It
takes 5–8 minutes (build, migrations, seed), and the site may not answer
until it finishes.

- **Anyone in the staff group** can run it. That's the owner's decision.
  Nobody outside the group gets an answer.
- **15-minute cooldown.** A second `/redeploy` inside it is told who started
  the first and when, instead of queuing another full build.
- **The reply never shows the deploy hook.** The hook URL is the credential.

**Setup** — only you can do this, since it needs your Render login:

1. Render → **got-api** → **Settings** → **Deploy Hook** → copy it.
2. From `ops/pinger/`: `npx wrangler@4 secret put RENDER_DEPLOY_HOOK` and
   paste it at the hidden prompt.

Until then, `/redeploy` replies with these instructions. That makes a safe
way to check the command works without restarting anything. If you ever
regenerate the hook in Render, repeat step 2.

`/check` arrives by **webhook**, so the Worker has a public URL. Both of its
routes refuse any caller without `TELEGRAM_WEBHOOK_SECRET`. While the
webhook is set, Telegram's `getUpdates` link stops working — that is expected.

**Setup** (already done for this deployment):

```bash
# a random secret: generate it, store it, and keep it for the next command
npx wrangler@4 secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler@4 deploy
curl -X POST -H "x-register-key: <that secret>" https://got-uptime-pinger.<subdomain>.workers.dev/telegram/register
```

Registration points Telegram at the Worker and publishes the command menu,
using the bot token the Worker already holds.

## Setup — about 10 minutes

You need a free Cloudflare account and the Telegram app. Run everything
from `ops/pinger/`.

### 1. Create the bot

In Telegram, message **@BotFather** → `/newbot` → pick a name. It replies
with a token like `123456:ABC-...`. **Treat it like a password.**

### 2. Find your chat id

Send your new bot any message (e.g. "hi"). Then open this in a browser, with
your token in place of `<TOKEN>`:

```
https://api.telegram.org/bot<TOKEN>/getUpdates
```

Find `"chat":{"id":123456789` — that number is your chat id. To alert a
group instead, add the bot to the group, send a message there, and use the
group's id (it starts with `-`).

That URL contains your token, so don't screenshot or share it.

### 3. Create the state store

```bash
npx wrangler@4 login
npx wrangler@4 kv namespace create PINGER_STATE
```

Copy the `id` it prints into `wrangler.toml`, replacing
`REPLACE_WITH_YOUR_KV_NAMESPACE_ID`. The id is not a secret and is safe to
commit.

### 4. Store the secrets

```bash
npx wrangler@4 secret put TELEGRAM_BOT_TOKEN
npx wrangler@4 secret put TELEGRAM_CHAT_ID
```

Each command prompts for the value. They live in Cloudflare, never in this
repository and never in `wrangler.toml`.

### 5. Deploy and watch it run

```bash
npx wrangler@4 deploy
npx wrangler@4 tail
```

`tail` streams the Worker's logs. You'll see a run at the next 10-minute
mark (or on the hour overnight).

## Test the alert before you need it

Put the two secrets in a local `.dev.vars` file (already gitignored):

```
TELEGRAM_BOT_TOKEN=123456:ABC-...
TELEGRAM_CHAT_ID=123456789
```

Point the check at a path that doesn't exist, then trigger one run:

```bash
npx wrangler@4 dev --test-scheduled --var HEALTH_URL:https://www.gym-of-thrones.site/api/no-such-route
# in a second terminal:
curl "http://localhost:8787/__scheduled"
```

A 🔴 DOWN message should arrive. Stop `dev`, start it again without the
`--var`, and trigger once more — you should get 🟢 back.

## Changing it

- **Schedule:** `[triggers] crons` in `wrangler.toml`. Cloudflare cron is UTC
  only; Manila is UTC+8.
- **Logic:** `src/monitor.ts`. Tests: `npx vitest run --root ops/pinger` from
  the repo root.
