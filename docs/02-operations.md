# Operations — deploy, environments, secrets, runbook

Read `README.md` and `01-architecture.md` first. This is the "how do I run/ship/debug
it" doc.

---

## Branch → environment mapping (the source of truth)

| Branch | Environment | Deploys to |
|--------|-------------|-----------|
| `v2` | **PRODUCTION** | DO `8c3788c6` (tenant API) + DO `5258cb89` (marketing/demo) + Netlify `socal-receptionist-v2` (SPA) → `app.socalreceptionist.com` |
| `v3-alpha` | **STAGING** | DO `8e427059` (tenant API) + Netlify `socal-receptionist-chat` (SPA) → `app2.socalreceptionist.com` |
| `master` / `main` | **nothing** | ⚠️ no-op, deploys nowhere |

- The DO apps deploy this repo (backend). The **SPA goes to Netlify**, never to the DO
  app (the Dockerfile builds only the Node API; static paths don't resolve in-container).
- GitHub Action `.github/workflows/deploy-spa.yml` builds + pushes the SPA to Netlify on
  pushes to `v2/web/**` (staging on `v3-alpha`).
- ⚠️ Pushing to `v2` deploys to **paying customers immediately.** Batch changes; deploy
  with the owner's go-ahead.

## Deploying

- **Backend (DO):** push to the branch, or trigger via `doctl apps create-deployment <app-id>`.
  Confirm health: `GET /health` on the app URL.
- **Frontend (Netlify):** push to `v2/web/**` (Action handles it) or
  `netlify deploy --prod --site <site-id>` from `v2/web/` after `npm run build`.
- **DB migrations:** apply `v2/db/*.sql` in order to the **correct** Supabase project
  (prod `fxjbxeckzeplixdgwbqk` / staging `xcngpfeuvvcsxgwyukch`). Never cross-project.
- After any deploy, verify the actual change is live (don't trust "build succeeded" — see
  the dead-`server.js` gotcha). A one-shot post-deploy check is the norm here.

## Local dev

```bash
# Backend (tenant API)
cd v2 && npm install && npm start          # node server/index.js
cd v2 && npm run worker                     # provisioning worker (RUN_WORKER path)

# Frontend
cd v2/web && npm install && npm run dev     # Vite dev server

# V1 marketing/demo (legacy)
npm install && npm start                     # node server.js
```
You'll need a `.env` with at least Supabase, Twilio, and OpenAI keys (see reference below).

---

## Environment variable reference

### Backend (`v2/server` + root)
- **Twilio:** `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_PHONE_NUMBER`,
  `TWILIO_VALIDATE_SIGNATURE`, `TWILIO_MESSAGING_SERVICE_SID` (A2P; set when campaign approved)
- **OpenAI:** `OPENAI_API_KEY`, `OPENAI_MODEL` (realtime model `gpt-realtime-2`)
- **Groq:** `GROQ_API_KEY`, `GROQ_MODEL` (onboarding chat)
- **Google:** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
  (roman@ — calendar), `GOOGLE_REFRESH_TOKEN_INFO`, `GOOGLE_REFRESH_TOKEN_SUPPORT` (Gmail monitoring)
- **Supabase:** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`
- **Stripe:** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, and the price IDs
  (`STRIPE_PRICE_ID_ESSENTIALS[_ANNUAL]`, `STRIPE_PRICE_ID_CONCIERGE[_ANNUAL]`,
  `STRIPE_SETUP_PRICE_ID[_CONCIERGE]`)
- **Email:** `RESEND_API_KEY`, `EMAIL_FROM` (V2 uses Resend; V1/src uses SMTP_* via Nodemailer)
- **Security:** `MFA_TOKEN_SECRET`, `RECAPTCHA_SECRET_KEY`, `INTERNAL_SECRET`
- **Monitoring:** `SENTRY_DSN`
- **Feature flags / config:** `SMS_ENABLED`, `CALLBACK_ENABLED`, `COMING_SOON`,
  `RUN_WORKER`, `WORKER_INTERVAL_MS`, `RECORDING_TENANT_IDS`, `PORT`, `NODE_ENV`,
  `APP_BASE_URL`, `API_BASE_URL` / `API_PUBLIC_BASE_URL`
- **Notifications:** `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
- **V3 integrations:** `CLIO_CLIENT_ID/SECRET`, `MYCASE_CLIENT_ID/SECRET`,
  `HUBSPOT_CLIENT_ID/SECRET`, `SALESFORCE_CLIENT_ID/SECRET`, `MS_CAL_CLIENT_ID/SECRET`,
  `GCAL_CLIENT_ID/SECRET`, `RINGCENTRAL_CLIENT_ID/SECRET`, `VONAGE_CLIENT_ID/SECRET`,
  `TELNYX_*`, `TOKEN_ENCRYPTION_KEY` (64-hex AES), `OAUTH_STATE_SECRET`, `TICKET_SYNC_INTERVAL_MS`

### Frontend (`v2/web`, build-time `VITE_` prefix)
`VITE_API_BASE`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `VITE_SMS_ENABLED`,
`VITE_CHAT_ONBOARDING`, `VITE_RECAPTCHA_SITE_KEY`, `VITE_SENTRY_DSN`, `VITE_POSTHOG_KEY`,
`VITE_GA_ID`, `VITE_GTM_ID`

### Asterisk connector (`.env` per client)
`TENANT_ID`, `ARI_URL`, `ARI_USER`, `ARI_PASSWORD`, `ARI_APP`, `AUDIOSOCKET_BIND/PORT`,
`AUDIOSOCKET_ADVERTISE_HOST`, `AUDIO_FORMAT=ulaw`, `JOSI_EXTENSION`, `PARK_EXTENSION/CONTEXT`,
`OUTBOUND_ENDPOINT_TEMPLATE`, `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL`, `SOCAL_API_BASE/KEY`,
`LOG_LEVEL`, `LOG_FILE`.

---

## Secrets map — where the real values live (NOT in git)

| Secret group | Lives in |
|--------------|----------|
| Backend prod secrets | DigitalOcean app env (`8c3788c6`, `5258cb89`) — `doctl apps spec get` |
| Backend staging secrets | DigitalOcean app env (`8e427059`) |
| Frontend secrets | Netlify site env (anon keys etc., baked at build) |
| DB keys | Supabase project settings (service key = backend; anon key = frontend) |
| Google OAuth tokens | DO app env (3 refresh tokens) + backed up in `credentials/` (gitignored) |
| Connector / dev box | `10.10.1.3` (passwordless sudo; OpenAI key at `~/env/oaikey`) |
| Misc tokens/notes | `credentials/` (gitignored), and the team's Notion/secret store |

⚠️ Do **not** commit secrets. The OpenAI key was once revoked by GitHub secret scanning —
keys go in platform env vars, never in the repo.

---

## External services inventory

| Service | Used for |
|---------|----------|
| **Twilio** | Phone numbers, inbound/outbound voice + SMS, A2P 10DLC campaign |
| **OpenAI** | Realtime API (voice), LLM responses |
| **Groq** | Fast LLM for onboarding chat wizard |
| **Supabase** | Postgres DB + auth (per environment) |
| **Stripe** | Subscriptions + billing (live mode), customer portal |
| **Google Workspace** | Calendar booking (OAuth) + Gmail inbox monitoring (info@/support@) |
| **Resend / SMTP** | Transactional email |
| **DigitalOcean** | Backend app hosting (3 apps) |
| **Netlify** | Frontend SPA hosting (2 sites) + marketing forms |
| **Cloudflare** | DNS for socalreceptionist.com (CNAMEs → Netlify) |
| **Sentry** | Error tracking (frontend `socal-receptionist-web`, backend `socal-receptionist-api`) |
| **PostHog / GA4 / GTM** | Product + web analytics |
| **UptimeRobot** | Uptime monitoring |
| **Notion** | Project hub / docs / task tracking |

---

## Common tasks

- **Onboard/provision a tenant:** signup → `onboarding/register.js` → provisioning worker
  buys a Twilio number, wires webhooks, attaches A2P. Legacy one-shot: `scripts/provision.js`.
- **Promote V3 → production:** it's a **merge** (`v3-alpha` → `v2`), not a swap. Before
  it's safe: run V3's DB migrations on the prod Supabase project, set new secrets
  (`TOKEN_ENCRYPTION_KEY`, `OAUTH_STATE_SECRET`, integration client IDs), and confirm
  nothing prod-only (e.g. recent legal/terms edits) is lost in the merge.
- **Run the Asterisk connector test rig:** on `10.10.1.3`, `~/freepbx-docker`
  (`docker compose up -d`) + `~/socal-asterisk-connector` (`node src/index.js`). See that
  repo's README and the dev-rig notes.
- **A2P status:** campaign SID `QE2c...`, messaging service `MG469...`; when APPROVED set
  `TWILIO_MESSAGING_SERVICE_SID` on the v2 + v3 DO apps.

---

## The full gotcha list (learn these or lose hours)

1. **Root `server.js` is dead in prod** — the Dockerfile runs `v2/server/index.js`.
   Edit live routes there.
2. **`master`/`main` deploy nowhere** — prod is `v2`, staging is `v3-alpha`.
3. **In-repo `.do/*.yaml` is stale** — trust live DO apps (`doctl apps spec get`).
4. **SPA never deploys to the DO app** — it's Netlify only.
5. **Two Supabase projects, never cross-migrate.**
6. **`v2` push = instant production deploy.**
7. **OpenAI Realtime is the GA API** — no `OpenAI-Beta` header; `gpt-realtime-2`;
   `audio/pcmu`. Beta is dead.
8. **Verify after deploy** — confirm the actual behavior changed, not just "build green."
9. **Connector debugging:** Node buffers stdout over a pipe and drops it on SIGTERM —
   use the connector's `LOG_FILE` sink for reliable logs. And `pkill -f "node src/index.js"`
   over SSH self-matches the SSH shell and kills your session — kill by port instead.
