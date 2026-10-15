# Paper amendments — what the build actually is

> Companion to *Online Membership Management System with Scheduling for Gym of
> Thrones* (proposal defense document). Agile: the document follows the build.
> Every row below is a verified difference between the paper and the running
> system, with the reason, so it can be defended rather than merely corrected.

---

## 1. Technical Background (p. 29) — rewrite the whole section

| Paper says | Build uses | Why the change |
|---|---|---|
| React + **Vite** | **Next.js 16** (App Router, React 19) | The public site needs server rendering for SEO and link previews; Vite ships a blank shell to a crawler. One framework now serves the marketing page, the member portal, the CRM and the desk display. |
| **Tailwind CSS** | Plain CSS design tokens in `globals.css` for the whole product, **plus Tailwind v4 + shadcn/ui for the member portal's schedule, bookings and calendar screens** | Three surfaces (portal, admin CRM, lobby desk) share one token set. The calendar and booking screens use shadcn/ui's accessible components (tabs, calendar, dialogs), with their colours mapped onto the same tokens, rather than hand-building keyboard and focus behaviour. |
| **Axios** | Native `fetch` behind a typed `apiFetch` wrapper | One dependency fewer, and one place that unwraps the `{ success, data }` envelope, attaches the token and turns an error body into a typed `ApiError`. |
| **Express.js** | **NestJS 11** (still Node.js) | Role-based access control is the core of this system. Nest's guards, interceptors and DTO validation make "every write route names one permission key" enforceable; in Express it would be middleware discipline nobody can audit. |
| **JWT + Bcrypt** in our code | **Supabase Auth** issues the JWT; the API verifies it locally against Supabase's JWKS | We never receive, hash or store a password. REQ025 ("never save plain-text passwords") is satisfied **by delegation** — say so explicitly, because there is deliberately no hashing code in our repository to show. |
| PostgreSQL | **Supabase PostgreSQL + Prisma ORM** | Same database engine. Prisma adds type-safe queries and versioned migrations; the integrity rules that matter (CHECK constraints, partial unique indexes) are hand-written SQL inside those migrations. |
| — | **Google Gemini** | Powers the AI assistant, and the workout plan generator. |
| — | **Resend** | Transactional email (invites, notifications). |
| — | **Vercel** (web) + a Node host for the API | Deployment. Railway's free trial has ended; host to be confirmed. |
| Helmet, CORS, JWT | unchanged — all three are in use | `main.ts` wires helmet, CORS from an allow-list, and global validation. |

**Table 1 (Benchmark, p. 27)** — "PERN Stack" is no longer accurate. Use:
**PostgreSQL · NestJS · Next.js (React) · Node.js — TypeScript throughout.**

---

## 2. Requirements to restate

| REQ | Change | Reason |
|---|---|---|
| **REQ004, REQ029** (OTP for registration/login, expiring OTP codes) | **Remove.** Replace with: *"The system shall support password reset and email verification through the managed authentication provider."* | Authentication is delegated to Supabase, which issues reset links rather than OTPs. An SMS OTP also carries a per-message cost with no security gain over the existing password + emailed link. The design document records this as owner decision #3: *"Keep Supabase password auth. No OTP on every login."* |
| **REQ028** (auto-logout after 10 minutes) | **Restate as staff and desk terminals only**, never member phones. | A member's phone locking itself mid-workout, at the door, is a support call. The same decision #3: *"Idle timeout applies to staff and admin terminals only, never to member phones."* |
| **REQ021** (Email + SMS + dashboard notifications) | **Drop SMS.** Read: *"Email and in-system dashboard notifications."* | SMS in the Philippines is prepaid and per-message; the gym has no provider account. Email plus the in-app Notifications panel covers renewals, expiry and inactivity at no running cost. |
| **REQ006** (Trial, Monthly, Quarterly, Annual) | **Strike "Trial".** | Confirmed with the owner: it was only an example. The catalogue is Walk-in ₱90, Monthly, Quarterly, Annual — prices editable in Settings. |
| **REQ022** (export reports in PDF) | Keep — being built. | The Reports screen exports PDF and CSV. |
| **REQ032** (check-in processed within 1 second) | Either soften to **1.5 s p95 end-to-end**, or measure at the gym and report the real figure. | The design budgets ≤ 80 ms p95 of server time and ≤ 1.5 s p95 scan-to-verdict on gym wifi. Claiming 1 second without a measurement is a number a panel can ask you to prove. |
| **REQ005** (Admin or Staff may register members) | Now true. | Front desk previously could sell a membership but not create the account it hangs off. Fixed — `member.create` granted to FRONT_DESK; role changes stay ADMIN-only. |
| **REQ010** (QR badge on the member dashboard) | Now true. | The code existed but sat behind a toggle on another screen; it is on the dashboard. |

---

## 3. Figures to update

- **Figure 17 (Walk-in Management).** We collect **Purpose of visit** and **Notes**; we do **not** collect **ID Type** (Data Privacy Act minimisation — a ₱90 guest should not surrender an ID number) and we do not ask for **Duration** (the system measures the real duration from check-in to check-out, which is better data than a guess at the counter). Conversion is **one guest at a time**, not a bulk checkbox action: each conversion creates an account and sends an invite, so a batch is error-prone.
- **Figure 15 (Membership Management).** The **"Switch to Member"** button is removed. Staff and member surfaces are separate by design; a staff member does not browse the site as a member.
- **All figures.** Currency is **₱**, not $. Times are **12-hour** (6:30 PM), not 24-hour.
- Replace wireframes with real screenshots where the built screen is richer than the mockup (landing page, member dashboard, attendance).

---

## 4. Add to Scope and Objectives — built, but absent from the paper

These are working features the document does not claim. They are worth adding: several are legal obligations a panel may ask about.

1. **Digital liability waiver and Data Privacy Act consent records** — versioned, timestamped, IP-hashed, re-prompted when the wording changes. Guests accept the waiver at the counter before entry.
2. **Statutory Senior Citizen and PWD discounts** per RA 9994 / RA 10754, with correct VAT-exempt computation and the ID number recorded for the BIR register.
3. **Cash-drawer shift reconciliation** — open a shift with a float, close it with a counted total, variance recorded.
4. **Promotional codes** with validity windows and redemption limits.
5. **Contact-form lead pipeline** — enquiries captured, worked, and linked to the member account when they join.
6. **Denial-to-walk-in conversion** — a member refused at the door appears on a staff rail and converts to a paid day pass in one action.
7. **Re-entry grace** — a member who steps out and returns within the window resumes the same visit instead of consuming a second one.
8. **GCash controls** — reference numbers normalised and deduplicated (a reused screenshot is a duplicate reference and is refused), plus a named staff attestation that the payment was seen in the gym's own app.
9. **Printable transaction slip** aligned to BIR rules for unregistered software, with a field tying the booklet invoice number to the system record.
10. **Station provisioning** for the QR display tablets, with rotating signed tokens.
11. **Engineering integrity work** — idempotency keys on money routes, database CHECK constraints, append-only membership history.
12. **Audit trail of dangerous actions** — payment voids, denial overrides, visit voids, suspensions and deletions (and their undo), role changes, plan price edits and opening-hours changes are recorded with who, when, why and what changed. Append-only: the account named by an entry cannot be deleted, and there is no route that edits or removes one. Forward-only from the date it shipped, and the screen states that date rather than letting an empty list imply that nothing has ever gone wrong.
13. **In-console notification board** — new enquiries and nightly-job outcomes raised where staff work, with read and resolved tracked separately. Its expiration-alert column is derived live from the memberships themselves rather than stored, so a renewal clears it with no sweep to keep it honest.

---

## 5. Interview claims now supported by the build

The owner's own words in Appendix A map to features — useful for Chapter 1 and for the defense narrative:

| Owner said | The system does |
|---|---|
| *"yung mga customer is umuuwi muna sa bahay or labas pasok sa gym to buy some drinks or snacks"* | Re-entry grace: leaving and returning within the window stays one visit. |
| *"one time or one day subscription lang yung iba"* | Walk-in day pass as a first-class sale, with its own register and conversion path. |
| *"nahihirapan kami i-check kung active pa ba ang membership or expired na"* | Live membership verdict at the door and on every screen; expiring lists and alerts. |
| *"Nahihirapan din kami minsan malaman kung sino available na coach"* | Coach directory, class-to-coach assignment, and the coach dashboard. |
| *"Payments, including cash and GCash, are also recorded by hand, including reference numbers"* | Payment recording with GCash reference capture, duplicate detection and a printable slip. |
