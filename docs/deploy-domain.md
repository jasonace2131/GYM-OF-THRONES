# Connecting `gym-of-thrones.site`

The domain is registered at GoDaddy. The site goes on Vercel, the API on
Render. This is the DNS and the settings, in the order they can actually be
done.

---

## The shape

| Hostname | Points at | Serves |
|---|---|---|
| `gym-of-thrones.site` | Vercel | Public site, member portal, staff console |
| `www.gym-of-thrones.site` | Vercel | Redirects to the apex |
| `api.gym-of-thrones.site` | Render | The API |

**The apex is canonical.** `www` redirects to it. Pick this once and do not
change it later — every QR code the gym prints for a station carries the origin
it was generated on, and changing which hostname is canonical silently
invalidates them.

---

## Order matters, and part of this has to wait

`api.gym-of-thrones.site` cannot be pointed anywhere until the Render service
exists, because there is no hostname to aim a CNAME at yet.

So:

1. **Now:** the apex and `www` at Vercel. DNS propagates while you do the rest.
2. **After Render is deployed:** the `api` subdomain.
3. **Then:** wire the three settings together.

---

## Step 1 — Vercel, the apex and www

In **Vercel** → Project → Settings → Domains → Add. Enter
`gym-of-thrones.site`, then add `www.gym-of-thrones.site` and set it to
redirect to the apex.

Vercel shows you the exact records to create. In **GoDaddy** → your domain →
**DNS** tab, they will look like this:

| Type | Name | Value | TTL |
|---|---|---|---|
| A | `@` | the IP Vercel shows you | 600 |
| CNAME | `www` | the hostname Vercel shows you | 600 |

**Use the values Vercel displays, not values copied from anywhere else**,
including this file. Those targets change, and a stale IP here would be worse
than no instructions.

**GoDaddy ships parking records that will fight you.** There is already an `A`
record on `@` pointing at GoDaddy's parking page and usually a `CNAME` on
`www`. Edit those rather than adding second ones. Two `A` records on `@` means
half your visitors land on a parking page.

Certificates issue automatically once DNS resolves. Usually minutes; give it an
hour before assuming something is wrong.

---

## Step 2 — Render, the API subdomain

Only after the Render service exists.

**Render** → your service → Settings → Custom Domains → Add
`api.gym-of-thrones.site`. It gives you a CNAME target ending in
`.onrender.com`.

In **GoDaddy** → DNS:

| Type | Name | Value | TTL |
|---|---|---|---|
| CNAME | `api` | `got-api-xxxx.onrender.com` | 600 |

---

## Step 3 — The four settings

The first two have an ordering trap: each side needs the other's address, so
one deploy of each happens with a value that is not yet right.

**In Vercel:**

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_API_URL` | `https://api.gym-of-thrones.site/api/v1` |
| `NEXT_PUBLIC_SITE_URL` | `https://gym-of-thrones.site` |

Then **redeploy Vercel**. Not restart. Both are `NEXT_PUBLIC_*`, which means
they are compiled into the browser bundle at build time; a restart carries the
old values.

`NEXT_PUBLIC_SITE_URL` is what makes link previews work. It sets
`metadataBase`, which is what turns `/og.jpg` into an absolute URL — and a
scraper on Facebook, Messenger or Viber fetches the page from its own servers
and cannot resolve a relative path. Without it, sharing the gym's link shows
nothing.

**In Render:**

| Variable | Value |
|---|---|
| `CORS_ORIGIN` | `https://gym-of-thrones.site,https://www.gym-of-thrones.site` |

**Both hosts, because `www` and the apex are different origins to a browser.**
Vercel serves the site at `www` and redirects the apex to it, so a list with
only the apex allows nothing the site actually sends.

Origin only: scheme, host, port. **No trailing slash, no path.** An `Origin`
header never carries a path, so `https://www.gym-of-thrones.site/` matches no
request ever made — see the failure below. Comma-separate to keep the
`vercel.app` URL working alongside it.

---

## Step 4 — Supabase, and this is the one that breaks silently

**Supabase** → Authentication → URL Configuration.

- **Site URL:** `https://gym-of-thrones.site`
- **Redirect URLs:** add `https://gym-of-thrones.site/reset-password`

The forgot-password flow passes `window.location.origin` as its redirect, and
Supabase refuses any redirect not on that allowlist. Signing in keeps working
perfectly, so nothing looks wrong until a member tries to reset a password and
the link dies. Add it at the same time as the domain, not when somebody
complains.

---

## Step 5 — Email, which this domain finally unblocks

Transactional email has been disabled this whole time for want of a sending
domain. `EmailService` logs `RESEND_API_KEY and/or RESEND_FROM unset — outbound
email is disabled` and carries on, so member invitations, password-reset mail
and enquiry notifications all silently do nothing.

1. **Resend** → Domains → Add `gym-of-thrones.site`.
2. It gives you DKIM and SPF records. Add them in GoDaddy DNS exactly as
   shown, as `TXT` and `CNAME` records.
3. Wait for Resend to show the domain verified.
4. On **Render**, set `RESEND_API_KEY` and `RESEND_FROM`, for example
   `Gym of Thrones <no-reply@gym-of-thrones.site>`.
5. Optionally set `CONTACT_NOTIFY_EMAIL` to wherever website enquiries should
   land. It falls back to `RESEND_FROM`.

This is also the prerequisite for the Phase 3 renewal and expiry notices.

---

## How to check it worked

```bash
# The site
curl -sI https://gym-of-thrones.site | head -1

# The API, once Render and the CNAME are both up
curl -s https://api.gym-of-thrones.site/api/health
```

The second should return `{"success":true,"data":{"status":"ok",...}}`.

Then open the site in a browser and sign in. If the page loads but every
request fails while the Render log looks healthy, it is `CORS_ORIGIN`.

**This happened on 9 September 2026**, and it is worth knowing the shape of it.
The value was pasted from a browser bar as `https://www.gym-of-thrones.site/`
— with the slash a browser puts there. The symptoms:

- `/api/health` answered `200`, so the API was plainly alive;
- the preflight answered `204` carrying allow-methods, allow-headers and
  allow-credentials — but **no `Access-Control-Allow-Origin`**;
- the browser therefore refused the response, and the console said
  *"blocked by CORS policy: No 'Access-Control-Allow-Origin' header"*;
- sign-in appeared to hang, because Supabase authenticated the password fine
  and it was the follow-up `GET /me` that was blocked.

It reads as "the server is down" and is nothing of the sort. Confirm it in one
command — a healthy origin echoes itself back:

```bash
curl -s -i -X OPTIONS https://api.gym-of-thrones.site/api/v1/me   -H "Origin: https://www.gym-of-thrones.site"   -H "Access-Control-Request-Method: GET" | grep -i access-control-allow-origin
```

No output means blocked. `buildCorsOptions` now strips trailing slashes, so
this exact typo can no longer cause it — but a wrong HOST still can.

---

## Two housekeeping notes

**Auto-renew is off.** The registration expires 8 September 2027. That is a
year away and fine for the defense, but if the gym keeps the domain, turn it on
or diary it. A lapsed domain takes the site, the API and the email sender down
together.

**Do not change which hostname is canonical after stations are provisioned.**
Station pairing QR codes embed the origin they were generated on.
