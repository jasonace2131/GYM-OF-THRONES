# Deploying the API free, temporarily — Render

Railway's trial ended. This is the stand-in until the permanent host is
decided. It is written for the defense window, not for real members.

`docs/deploy.md` remains the reference for what every environment variable
means and why. This file only covers what is different on Render.

---

## Which free host, and why this one

| Host | Free? | Needs a Dockerfile | The catch |
|---|---|---|---|
| **Render** | Yes, 750 instance-hours a month | No, native Node | Spins down after ~15 min idle; ~50 s to wake |
| **Google Cloud Run** | Yes, genuinely free at this scale | **Yes** | Scales to zero; you would be writing and debugging a Dockerfile first |
| **Koyeb** | Small free allowance | No | Tighter memory; smaller region choice |
| **Fly.io** | No longer really free | No | Roughly $2–5 a month, but always-on and the least fuss |
| **Vercel** | Yes | n/a | **Wrong shape.** Serverless functions cannot hold the desk's Server-Sent Events feed open, and there is no process to run the nightly job in |

**Render, because it needs no Dockerfile.** That is the whole argument. Cloud
Run is the better long-term answer and costs nothing at this volume, but it
wants a container image the repository does not have, and a defense is a poor
time to be debugging one. Fly.io is the least trouble of all if a few dollars
a month is acceptable.

Free-tier terms change. Check the current ones before you rely on the numbers
above.

---

## The two things that break on a sleeping instance

Neither is cosmetic, and both have the same fix.

**The nightly membership job runs in-process at 03:15 Manila.** A sleeping
instance does not run it. Nothing is admitted or refused wrongly — the door
recomputes from dates every time — but expiries look a day stale in the console
until it next runs.

**The desk's live feed is Server-Sent Events.** A spin-down drops every open
connection.

**The fix:** keep it awake with a free uptime pinger hitting `/api/health`
every 10 minutes. UptimeRobot and cron-job.org both do this at no cost. The
arithmetic works out: 750 instance-hours is 31 days of always-on, so one
permanently awake service still fits inside the free allowance.

---

## Steps

**1. Rotate the Supabase `service_role` key first** if you have not since it
was last in a `.env` on a laptop. `docs/deploy.md` §0.

**2. New Blueprint.** Render dashboard → New → Blueprint → point it at
`uriaannn/GYM-OF-THRONES`, branch `main`. It reads `render.yaml` at the repo
root and creates one web service.

**3. Fill in the secrets it prompts for.** Everything marked `sync: false`:

| Variable | Where it comes from |
|---|---|
| `DATABASE_URL` | Supabase → Connect → **Transaction pooler**, port 6543. **Must end with `?pgbouncer=true&connection_limit=5`** |
| `DIRECT_URL` | Supabase → Connect → **Session**, port 5432 |
| `SUPABASE_URL` | Supabase → Settings → API |
| `STATION_TOKEN_SECRET` | Generate — `docs/deploy.md` §1 |
| `STATION_CREDENTIAL_PEPPER` | Generate |
| `IP_HASH_PEPPER` | Generate |
| `SUPABASE_SERVICE_KEY` | Optional. Needed only to create members from the console and to store GCash receipt images; both warn-and-disable without it |
| `CORS_ORIGIN` | Your Vercel URL. See the ordering note below |

**4. Deploy, and watch the log for three lines.** In order:

```
… migrations have been successfully applied
Seeded 55 permissions.
Seeded 94 role permission grants.
Nest application successfully started
```

If the permission count is lower than 55, the seed did not run against the
right database, and the console will 403 an ADMIN with nothing to point at.

**5. Point the client at it.** In Vercel, set `NEXT_PUBLIC_API_URL` to
`https://<your-render-service>.onrender.com/api/v1` and **redeploy**. That value
is baked into the browser bundle at build time, so a restart is not enough.

> Once the custom domain is live this becomes
> `https://api.gym-of-thrones.site/api/v1`. See `docs/deploy-domain.md` — the
> `api` subdomain cannot be pointed anywhere until this service exists, so
> deploy first and add the domain after.

**6. Then set `CORS_ORIGIN` on Render** to the Vercel URL and let it redeploy.
This is the chicken-and-egg from `docs/deploy.md` §4: each side needs the
other's address, so one deploy of each has to happen with the wrong value.

**7. Add the pinger.** `https://<service>.onrender.com/api/health`, every 10
minutes.

---

## What will go wrong first

**`nest: not found` during the build.** You set `NODE_ENV=production` as a
service variable. It is present at build time too, where npm reads it as
`--omit=dev` and skips the compiler. It belongs in the start command, which is
where `render.yaml` already puts it. Remove the variable.

**Random 500s on unrelated endpoints, with "prepared statement s0 already
exists" in the log.** `DATABASE_URL` is missing `?pgbouncer=true`.

**The console loads but every request fails, and the server log shows
nothing.** `CORS_ORIGIN` does not match the Vercel URL exactly. It is
origin-only: no trailing slash, no path.

**`P1001` on boot.** Supabase pauses free projects after about a week of
inactivity. Open the Supabase dashboard to wake it. Do this before a demo, not
during one.

**First request after idle takes most of a minute.** That is the spin-down.
The pinger is the answer.

---

## Before the defense

Wake both Supabase and the API an hour before, then click one walk-in sale and
one check-in to confirm the whole chain is live. A cold start in front of a
panel reads as a broken system even though it is a free-tier trait.
