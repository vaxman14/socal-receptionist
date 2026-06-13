# SoCal Receptionist — Engineering Handbook

> If you're a new engineer picking this up: **read this file top to bottom first**, then
> `01-architecture.md`, then `02-operations.md`. The single most important thing to
> internalize is the **V1 / V2 / V3 environment split** and the **deploy gotchas** —
> get those wrong and you ship to production by accident or "fix" dead code.

SoCal Receptionist is an **AI receptionist SaaS** for small businesses (law firms,
dental/medical offices, accountants, etc.). It answers phone calls and SMS with an AI
agent (OpenAI Realtime for voice), books appointments, captures leads, and pushes data
into the customer's calendar/CRM. Multi-tenant: each customer ("tenant") signs up,
gets provisioned a phone number, and manages everything from a web dashboard.

There are **four** code-bases/systems to understand:

| # | System | Repo | What it is |
|---|--------|------|------------|
| 1 | **Marketing site + demo/sales voice line** | this repo, root (`server.js`, `src/`) ⚠️ see gotcha | The public site + the demo phone line people call to hear the AI |
| 2 | **V2 — Production SaaS** | this repo, `v2/` on branch `v2` | The live multi-tenant product (API + React dashboard) |
| 3 | **V3 — Staging SaaS** | this repo, `v2/` on branch `v3-alpha` | Same codebase, next-gen features, staging environment |
| 4 | **Asterisk Concierge Connector** | `github.com/vaxman14/socal-asterisk-connector` | On-prem PBX integration ("Josi" voice concierge over ARI) — newest, proof-of-concept |

---

## 🗺️ WHERE IS WHAT — the master map

> ⚠️ **CARDINAL RULE:** `v2` branch = **PRODUCTION**. `v3-alpha` branch = **STAGING**.
> Two branches, two environments, two databases. **Never mix them.** A change pushed to
> `v2` is live to paying customers immediately.

### Production (branch `v2`)
| Layer | Where | ID / URL |
|-------|-------|----------|
| Frontend (React SPA) | Netlify site `socal-receptionist-v2` | `app.socalreceptionist.com` (ID `955fde3a-32e9-4f08-b304-c0c1611b85a7`) |
| Tenant API backend | DigitalOcean app `socal-receptionist-v2` | `socal-receptionist-v2-spbrw.ondigitalocean.app` (ID `8c3788c6-828f-46f8-a908-b1873d57001f`) |
| Marketing + demo voice line | DigitalOcean app `socal-receptionist` | `www.socalreceptionist.com` + demo line **(951) 395-8776** (ID `5258cb89-9b5a-451c-9f63-1eb84736040f`) |
| Database | Supabase project | `fxjbxeckzeplixdgwbqk` (`https://fxjbxeckzeplixdgwbqk.supabase.co`) |

### Staging / Dev (branch `v3-alpha`)
| Layer | Where | ID / URL |
|-------|-------|----------|
| Frontend (React SPA) | Netlify site `socal-receptionist-chat` | `app2.socalreceptionist.com` |
| Tenant API backend | DigitalOcean app `socal-receptionist-v3` | ID `8e427059-...` |
| Database | Supabase project | `xcngpfeuvvcsxgwyukch` |

### Asterisk Concierge (separate repo + deploy model)
| Layer | Where |
|-------|-------|
| Code | `github.com/vaxman14/socal-asterisk-connector` (private) |
| Runtime | One small VM **per client** (e.g. DigitalOcean droplet), reached over a WireGuard tunnel to the client's on-prem Asterisk/FreePBX PBX |
| Brain | OpenAI Realtime API (cloud) |
| Dev/test box | `10.10.1.3` (disposable; FreePBX 17 dev rig in Docker) |

---

## 🚨 The three gotchas that will bite you

1. **Root `server.js` is DEAD CODE in production.** The root `Dockerfile` CMD is
   `node v2/server/index.js`. So even the "marketing/V1" DO app (`5258cb89`) runs
   `v2/server/index.js`, NOT the root `server.js`. If you edit a route in root
   `server.js` (e.g. `/terms`) it changes **nothing live**. Edit `v2/server/index.js`.

2. **`master` / `main` deploy NOWHERE.** Old notes say "deploy branch is master" — that
   is stale. Pushing to `master` is a no-op for every environment. Production is `v2`,
   staging is `v3-alpha`.

3. **The in-repo `.do/app.yaml` specs are stale.** Trust the **live DigitalOcean apps**
   (IDs above), not the YAML in the repo. Verify with `doctl apps spec get <id>`.

---

## Doc index

- **`01-architecture.md`** — system-by-system deep dive (V1, V2, V3, Asterisk), data flows, repo layout, env var reference.
- **`02-operations.md`** — deploy runbook, branch→environment mapping, secrets map, external services inventory, common tasks, and the full gotcha list.
- The Asterisk connector has its own detailed `README.md` in its repo.

## Durable context beyond the code

A large amount of project history, decisions, and credentials live outside the repo:
- **Notion** "SoCal Receptionist HQ" — product hub, this handbook is mirrored there.
- Credentials are in DigitalOcean / Netlify / Supabase env vars and `credentials/` (gitignored), **not** committed. See `02-operations.md` → Secrets map.
