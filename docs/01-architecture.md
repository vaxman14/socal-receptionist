# Architecture — system by system

This doc goes component by component. For the high-level map and environment split, see
`README.md` first.

---

## Repository layout (this repo)

```
socal-receptionist/
├── server.js              # V1 marketing/demo backend — ⚠️ DEAD in prod (see gotcha #1)
├── src/                   # V1 support modules (voice-realtime, twilio, email, gcal, ...)
├── public/                # V1 static marketing assets / legal pages
├── Dockerfile             # ROOT image. CMD = node v2/server/index.js  ← runs the V2 server
├── .do/                   # DigitalOcean app specs — ⚠️ STALE, don't trust over live apps
├── .github/workflows/
│   └── deploy-spa.yml      # GitHub Action: builds + deploys the React SPA to Netlify
├── credentials/           # gitignored secrets/notes
├── scripts/               # provisioning + ops scripts (e.g. provision.js)
└── v2/                    # ← THE PRODUCT (V2 prod on branch v2, V3 staging on v3-alpha)
    ├── Dockerfile         # v2 image (multi-stage). Also runs server/index.js
    ├── db/                # *.sql migrations (run against Supabase, in order)
    ├── server/            # the tenant API (Node/Express)
    └── web/               # the React SPA (Vite)
```

**Branch = environment.** The *same* `v2/` tree is production on branch `v2` and staging
on branch `v3-alpha`. `v3-alpha` is ahead of `v2` by a set of V3 features (integrations,
outbound assist, etc. — see "V3" below). Do not assume a file's contents are identical
across branches; `git diff v2 v3-alpha` before reasoning about V3.

---

## 1. Marketing site + demo / sales voice line

- **Code:** root `server.js` + `src/` (Express). Modules in `src/`: `voice-realtime.js`
  (Twilio Programmable Voice realtime call handling), `voice-sales.js`, `twilio.js`,
  `ai.js`, `email.js` / `email-poller.js` / `gmail-monitor.js` (inbox monitoring),
  `gcal.js` / `calendly.js` (booking), `consent.js` (TCPA), `config.js`, `store.js`.
- **Live app:** DigitalOcean `5258cb89` at `www.socalreceptionist.com` + demo/sales line
  **(951) 395-8776**. The voice sales agent qualifies callers, fetches Calendly
  availability, and books via Google Calendar (Google OAuth, roman@ refresh token).
- ⚠️ **Reality check:** the root `Dockerfile` CMD runs `v2/server/index.js`, so what's
  *actually serving* on `5258cb89` is the v2 server with marketing/demo env config — the
  root `server.js` code is not the live request handler. Treat `src/` as legacy reference
  unless you confirm a specific path is wired. **Always verify against the running app.**
- **Main line note:** **(951) 395-8776** is the primary SoCal Receptionist number. Don't
  confuse with tenant or client numbers.

---

## 2 & 3. V2 (production) and V3 (staging) — the SaaS product

Same codebase under `v2/`. V2 = branch `v2`, V3 = branch `v3-alpha`. Backend + frontend.

### Backend — `v2/server/` (Node/Express)

- **`index.js`** — entry point. Mounts SMS + voice routers, serves legal pages
  (`/terms`, `/privacy`, `/cookies`, `/accessibility`, `/data-deletion`, `/sms-terms`)
  and the built SPA. ⚠️ The live `/terms` etc. are rendered **here**, not in root
  `server.js`. On V3 it also auto-starts the reminder poller + ticket-sync on boot.
- **`voice/`** — `webhook.js` (inbound call routing/TwiML), `realtime.js` (OpenAI
  Realtime voice — see the Realtime API notes below), `outbound-assist.js` +
  `reminder-poller.js` (**V3 only**).
- **`sms/webhook.js`** — inbound SMS router + AI reply + abuse guards.
- **`onboarding/`** — `register.js` (signup), `agreement.js`, `numbers.js` (Twilio
  number provisioning), `chat.js` (AI onboarding wizard).
- **`provisioning/`** — `handlers.js` + `worker.js`/`run-worker.js`: a state-machine
  worker that buys Twilio numbers, wires webhooks, attaches A2P campaign, releases
  numbers on cancellation. Run with `RUN_WORKER=true` (or the `worker` npm script).
- **`billing/webhook.js`** — Stripe webhooks (subscriptions, cancellation).
- **`auth/mfa.js`** — TOTP MFA.
- **`admin/`** — `client.js` (tenant dashboard APIs), `owner.js` (platform/owner APIs).
- **`contracts/`** — service agreement markdown (`service-agreement-v1.md`,
  `service-agreement-v2.md`) + template service.
- **`integrations/`** (**V3 only** — not on `v2`): `router.js`, `clio.js`/`mycase.js`
  (legal practice mgmt), `hubspot.js`/`salesforce.js` (CRM), `microsoft-calendar.js`,
  `ringcentral.js`/`vonage.js`/`telnyx.js` (SIP), `ticket-sync.js`, plus
  `lib/contact-resolver.js`, `lib/token-crypto.js`, `lib/public-api.js`.
- **`lib/`** — shared: `ai.js` (LLM prompting), `usage.js`, `ratelimit.js`,
  `abuse-guard.js`, `billing.js`/`stripe.js`, `supabase.js`, `tenants.js`,
  `twilio.js`, `email.js`, `recaptcha.js`, `consent.js`, `retention.js`, etc.

### Frontend — `v2/web/` (Vite + React 18 + React Router)

- **Build:** `npm run build` → `dist/`. Deployed to **Netlify** (not the DO app — the
  DO Dockerfile builds the Node API only; the SPA must live on Netlify).
- **Pages** (`src/pages/`): `Login`, `Register`, `ResetPassword`, MFA screens;
  `client/` (tenant dashboard: Overview, Calls, Leads, Billing, Settings, plus V3
  IntegrationSettings/TimeTickets/OutboundLeads); `owner/` (PlatformOverview, Tenants,
  TenantDetail, AuditLog, Documents); `onboarding/` (Wizard + steps, ChatWizard).
- **Auth:** Supabase auth (anon key baked into the build); JWT to the API.
- Analytics/monitoring gated on env vars: PostHog, GA4, GTM, Sentry.

### Database — Supabase (`v2/db/*.sql`)

- Migrations are plain SQL, applied in numeric order against the project's Postgres.
- **Prod** project `fxjbxeckzeplixdgwbqk`; **staging** project `xcngpfeuvvcsxgwyukch`.
- ⚠️ **Never run migrations cross-project.** V3 has several migrations (time_tickets,
  integrations, outbound_assist, public_api, RLS, platform_leads) that prod does NOT
  have. Promoting V3 → prod requires running those on the prod project first.

### V3-specific scope (what `v3-alpha` adds over `v2`)

Outbound Call Assist + proactive reminders, practice-mgmt/CRM integrations
(Clio/MyCase/HubSpot/Salesforce), Microsoft Calendar, SIP trunk integrations, public
API, analytics dashboard, recordings/transcripts. See the V3 feature roadmap in Notion.
The **native Asterisk concierge** (system 4) is the deepest V3 differentiator.

---

## OpenAI Realtime (voice) — GA API, not Beta

Voice uses the **OpenAI Realtime API (GA shape)**. The Beta API is dead.

- WS: `wss://api.openai.com/v1/realtime?model=gpt-realtime-2` — **no** `OpenAI-Beta` header.
- `session.update` uses `{ type:'realtime', output_modalities:['audio'],
  audio:{ input:{ format:{type:'audio/pcmu'}, turn_detection:{type:'semantic_vad'} },
  output:{ format:{type:'audio/pcmu'}, voice:'marin' } }, tools, tool_choice }`.
- `audio/pcmu` = G.711 μ-law = Twilio's and Asterisk-ulaw's format → no resampling.
- Key event renames vs Beta: `response.output_audio.delta`,
  `response.output_audio_transcript.delta`. Models: `gpt-realtime-2` (best),
  `gpt-realtime`, `gpt-realtime-mini`. Voices: `marin`/`cedar` (best), `alloy`, etc.
- Production reference: `v2/server/voice/realtime.js` (+ `REALTIME_API_NOTES.md` if present).
  ⚠️ Every field in `session.update` is deliberate; wrong params = silent failure/garbage audio.

---

## 4. Asterisk Concierge Connector (`socal-asterisk-connector`)

The newest piece — a **per-client on-prem PBX integration** so a customer can press a
"Josi" key on their desk phone, say "get me Robert on the line," and the AI places,
screens, parks, and connects the call like a live receptionist.

- **Why it exists:** a big chunk of the local target market runs phone systems installed
  by **CQ Simple ("Nimbus" PBX) / TVC**, which are **FreePBX/Asterisk** under the hood.
  This connector drops into any Asterisk-family PBX (FreePBX, Nimbus, Issabel, VitalPBX).
- **Architecture (two planes):**
  - **Control plane = ARI** (Asterisk REST Interface): originate, bridge, park, ring
    extension. The connector registers a Stasis app (`josi-concierge`).
  - **Audio plane = AudioSocket** (ulaw, 8kHz, no resample) bridged to OpenAI Realtime.
  - **Connectivity:** one VM **per client** (per-client isolation is a hard requirement),
    reached over a **WireGuard** tunnel from the client's router. Outbound-only tunnel,
    allowed-IPs scoped to the Asterisk host. No hardware on site, no inbound firewall holes.
- **Status:** validated end-to-end on FreePBX 17 / Asterisk 21 — live call → speech →
  `place_call` tool → contact resolution → the AI speaks back and disambiguates. The
  outbound→park→ring-extension leg and the real `/api/contacts/resolve` wiring are the
  remaining build items.
- **Code map (in that repo):** `src/ari/connector.js` (ARI + media attach + park/ring),
  `src/ari/callFlow.js` (the scenario state machine), `src/audio/audioServer.js`
  (AudioSocket protocol), `src/audio/bridge.js` (media ↔ Realtime), `src/realtime/
  openaiRealtime.js` (GA client), `src/contacts/resolver.js`, `docker/` (FreePBX/Asterisk
  dev rig). Full detail in that repo's `README.md`.

### How the desk-phone flow works (target UX)

```
Yealink "Josi" key → ext 700 (dialplan) → Stasis(josi-concierge)
   → connector answers, bridges call audio ↔ OpenAI Realtime (via AudioSocket)
   → user: "get me Robert"  → model calls place_call tool
   → connector resolves contact (V3 backend /api/contacts/resolve)
   → originate outbound to Robert over the trunk → AI screens
   → if yes: park Robert on the PBX park lot, ring the principal's extension
   → if no:  take a message, ring the principal's extension to report
```
