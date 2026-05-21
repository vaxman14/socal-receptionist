# Codex Review Prompt — SoCal Receptionist V2 (Self-Serve SaaS)

> Paste this into Codex (or run `codex` inside the `socal-receptionist/` repo).
> Goal: get a critical second opinion on the V2 architecture **before** we build it.

---

## Your task

You are reviewing a proposed V2 architecture for an existing product. Read the
current codebase first (`server.js`, `src/`, `scripts/provision.js`, `README.md`),
then critique the V2 plan below. **Do not write implementation code.** Give an
opinion: what's sound, what's risky, what's missing, and what you'd do differently.

## Current state (V1 — what exists today)

- Node.js 20 + Express single app. Inbound SMS → `POST /sms` → GPT-4o reply via
  Twilio TwiML. Captures leads, emails the business owner (Nodemailer).
- **One client = one DigitalOcean App Platform app**, configured entirely by
  env vars (`BUSINESS_NAME`, `TWILIO_PHONE_NUMBER`, `CALENDLY_LINK`, etc.).
- `scripts/provision.js` is an **interactive CLI**: buys a Twilio number, creates
  a new DO app for that client, wires the webhook. Operator-run, one client at a time.
- Conversation state is **in-memory** (`src/store.js`) — lost on restart, not
  shared across instances. No database except a Supabase table used only for
  SMS consent (`src/consent.js`).
- No auth, no billing, no admin UI, no transcript persistence.

## Proposed V2 (the plan to critique)

**Goal:** a customer buys a plan on the website and has a working AI receptionist
live within ~15 minutes, fully self-serve. 7-day free trial. Client billing admin.
Owner (super-admin) dashboard with per-client stats and full transcripts.

1. **Multi-tenancy refactor.** Stop creating one DO app per client. Run a single
   multi-tenant app. On `POST /sms`, look up the tenant by the inbound `To`
   number in Supabase and load that tenant's config from a DB row instead of
   env vars. `provision.js` logic moves server-side and stops creating DO apps.
2. **Data model (Supabase/Postgres):** `tenants`, `subscriptions`, `phone_numbers`,
   `conversations`, `messages` (full transcripts), `leads`. RLS so a tenant sees
   only its own rows; service role for the SMS webhook.
3. **Self-serve onboarding wizard** (web): collect business name, hours, services,
   Calendly link, owner email, desired area code → Stripe Checkout → on
   `checkout.session.completed` webhook, auto-provision: buy a Twilio number,
   write the tenant row, wire the webhook. No human in the loop.
4. **Billing:** Stripe Checkout + Customer Portal, 7-day trial via
   `subscription_data.trial_period_days`. Stripe webhooks sync status; suspend
   service on cancel/non-payment.
5. **Client admin:** login, edit business config, view their own leads &
   transcripts, manage billing via Stripe Portal.
6. **Owner super-admin:** all tenants, MRR/usage/lead stats, read any transcript.

## Questions to answer in your review

1. Is the **single multi-tenant app** the right call vs. keeping per-client DO
   apps? Trade-offs for isolation, blast radius, cost, and deploy complexity.
2. **A2P 10DLC / SMS compliance** is the suspected real blocker on "live in 15
   minutes." Can new client numbers send US SMS immediately, or does brand/
   campaign registration gate it? What's the correct Twilio setup (Messaging
   Service + a shared campaign? per-tenant campaigns?) to make instant
   onboarding real and compliant? Is "15 minutes" honest, or should we promise
   "configured in 15 min, sending once carrier registration clears"?
3. Where should conversation state live now that it must persist and be shared
   (Postgres directly, Redis, etc.)? Latency vs. Twilio's 15s webhook timeout.
4. Failure modes in auto-provisioning: payment succeeds but no Twilio number is
   available in the area code, webhook wiring fails, deploy race conditions.
   How should partial failures be handled / made idempotent / refunded?
5. Security: tenant isolation, Twilio signature validation per-number, RLS
   correctness, protecting the super-admin surface, secrets handling.
6. Stripe specifics: trial without a card vs. card-required; handling failed
   payment after trial; what exactly suspends service.
7. Stack fit: the sibling project WebLaunchGuard already uses React+Vite +
   Netlify Functions + Supabase + Stripe with an admin panel. Should V2 reuse
   that stack/templates, or stay Express-on-DigitalOcean? Recommend one.
8. Anything missing from this plan that will hurt at 20–50 paying clients
   (observability, per-tenant rate limits, OpenAI cost controls, data export,
   call/voice handling, opt-out/STOP keyword handling)?

## Output format

- **Verdict:** is the plan sound enough to start building? (yes / yes-with-changes / no)
- **Critical risks** (ranked) — anything that could sink it.
- **Recommended changes** to the architecture above.
- **Suggested build order** — what to do first to de-risk fastest.
- Keep it concise and opinionated. No code.
