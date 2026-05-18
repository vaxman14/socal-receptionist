# SoCal Receptionist

An AI-powered SMS receptionist for local businesses (dentists, plumbers,
contractors, salons, etc.). It answers customer texts 24/7, qualifies leads,
shares a Calendly booking link, and emails the business owner whenever a new
lead is captured.

One codebase serves many clients — each client is just a different set of
environment variables. No code changes are needed to onboard a new business.

## How it works

```
Customer texts the business number
        │
        ▼
Twilio  ──POST /sms webhook──▶  Express app
                                   │
                                   ├─ GPT-4o generates a friendly reply
                                   │
                                   ├─ capture_lead tool ──▶ emails owner (Nodemailer)
                                   │                        + sends Calendly link
                                   │
                                   └─ request_human_followup ──▶ emails owner
        │
        ▼
TwiML response ──▶ Twilio ──▶ SMS reply delivered to the customer
```

- **Inbound SMS** — Twilio posts each incoming text to `POST /sms`.
- **AI responses** — OpenAI GPT-4o acts as a friendly, professional receptionist.
- **Lead qualification** — the AI collects name, contact info, and service needed.
- **Booking** — once qualified, the AI shares the client's Calendly link (no
  Calendly API needed in V1).
- **Outbound SMS** — the reply (including booking link / confirmation) is
  returned to Twilio as TwiML and delivered to the customer.
- **Owner notifications** — every captured lead, and every unanswered question,
  triggers an email to the business owner.

## Tech stack

| Concern        | Choice                                  |
|----------------|------------------------------------------|
| Backend        | Node.js 20 + Express                     |
| SMS            | Twilio (inbound webhook + outbound TwiML)|
| AI             | OpenAI GPT-4o (tool calling)             |
| Scheduling     | Calendly link (no API in V1)             |
| Email          | Nodemailer (any SMTP provider)           |
| Hosting        | DigitalOcean App Platform                |
| Storage        | None — in-memory conversation state only |

## Project structure

```
socal-receptionist/
├── server.js          Express app + Twilio /sms webhook
├── src/
│   ├── config.js      Loads & validates environment variables
│   ├── ai.js          GPT-4o receptionist + lead/follow-up tools
│   ├── store.js       In-memory per-customer conversation memory
│   ├── twilio.js      Twilio client + webhook signature validation
│   └── email.js       Nodemailer owner notifications
├── Dockerfile
├── .do/app.yaml       DigitalOcean App Platform spec (optional)
├── .env.example       All configuration, documented
└── README.md
```

## Environment variables

Every value is per-client configuration. See [`.env.example`](.env.example)
for a documented template.

| Variable                   | Required | Description                                            |
|-----------------------------|----------|--------------------------------------------------------|
| `PORT`                      | no       | Server port (App Platform sets this; defaults to 8080).|
| `TWILIO_ACCOUNT_SID`        | yes      | Twilio account SID.                                    |
| `TWILIO_AUTH_TOKEN`         | yes      | Twilio auth token.                                     |
| `TWILIO_PHONE_NUMBER`       | yes      | The Twilio number customers text (E.164, e.g. `+1...`).|
| `TWILIO_VALIDATE_SIGNATURE` | no       | `false` disables signature checks (local testing only).|
| `OPENAI_API_KEY`            | yes      | OpenAI API key.                                        |
| `OPENAI_MODEL`              | no       | Defaults to `gpt-4o`.                                  |
| `BUSINESS_NAME`             | yes      | The client business name.                              |
| `BUSINESS_HOURS`            | yes      | Free-text hours, shown to the AI.                      |
| `BUSINESS_SERVICES`         | yes      | Free-text list of services offered.                    |
| `CALENDLY_LINK`             | yes      | The client's Calendly booking URL.                     |
| `OWNER_EMAIL`               | yes      | Where lead / follow-up notifications are sent.          |
| `SMTP_HOST`                 | yes      | SMTP server host for Nodemailer.                        |
| `SMTP_PORT`                 | no       | SMTP port (defaults to 587; 465 uses TLS).             |
| `SMTP_USER`                 | yes      | SMTP username.                                          |
| `SMTP_PASS`                 | yes      | SMTP password / API key.                                |
| `SMTP_FROM`                 | no       | From address; defaults to the business name + SMTP user.|

## Run locally

```bash
cd socal-receptionist
npm install
cp .env.example .env        # then edit .env with real values
npm run dev
```

To test the Twilio webhook locally, expose your port with a tunnel
(e.g. `ngrok http 8080`), set `TWILIO_VALIDATE_SIGNATURE=false`, and point
your Twilio number's "A message comes in" webhook at
`https://<your-tunnel>/sms`.

Health check: `GET /health` returns `{ "status": "ok", ... }`.

## Deploy to DigitalOcean App Platform

App Platform gives you auto-scaling, high availability, and managed deploys
straight from GitHub.

### 1. Push to GitHub

```bash
cd socal-receptionist
git init && git add . && git commit -m "Initial commit"
git remote add origin https://github.com/<you>/socal-receptionist.git
git push -u origin main
```

### 2. Create the app

1. Go to <https://cloud.digitalocean.com/apps> → **Create App**.
2. Choose **GitHub** as the source and select your repository / `main` branch.
3. Enable **Autodeploy** so every push to `main` redeploys.
4. App Platform detects the `Dockerfile` and builds from it automatically.
5. Set the **HTTP port** to `8080`.
6. Set the **health check** HTTP path to `/health`.

> Alternatively, deploy from the spec: `doctl apps create --spec .do/app.yaml`
> (edit the `github.repo` field first).

### 3. Configure environment variables

In the app's **Settings → App-Level Environment Variables**, add every
variable from the table above. Mark secrets (`TWILIO_AUTH_TOKEN`,
`OPENAI_API_KEY`, `SMTP_PASS`, etc.) as **encrypted**.

### 4. Deploy and get the URL

After the first deploy, App Platform assigns a public URL like
`https://socal-receptionist-xxxxx.ondigitalocean.app`.

### 5. Point Twilio at the app

1. In the [Twilio Console](https://console.twilio.com/) open your phone
   number → **Messaging**.
2. Under **A message comes in**, choose **Webhook**, set the URL to
   `https://<your-app-url>/sms`, and the method to **HTTP POST**.
3. Save. Text the number — you should get an AI reply, and the owner inbox
   should receive a notification once a lead is captured.

### 6. Onboard another client

Create a second App Platform app (or a second component) from the same repo
with a different set of environment variables, and assign it a different
Twilio number. No code changes required.

## Scaling notes (V1 limitations)

V1 has **no database** and is intentionally simple:

- Conversation memory lives in-process ([`src/store.js`](src/store.js)) so the
  AI can qualify a lead across several texts. It is cleared on restart and is
  **not shared between instances**. Run a **single instance** in V1, or expect
  a customer's multi-text conversation to occasionally restart if their
  messages land on different instances.
- For multi-instance auto-scaling, V2 should move conversation state to a
  shared store (e.g. DigitalOcean Managed Redis) — that is the only change
  needed to make this fully horizontally scalable.
- The Twilio webhook responds synchronously; GPT-4o replies well within
  Twilio's 15-second webhook timeout under normal conditions.

## Security

- Inbound requests are verified with Twilio's `X-Twilio-Signature` header
  (`TWILIO_VALIDATE_SIGNATURE=true`, the default). Keep it enabled in
  production; only disable it for local tunneled testing.
- Never commit `.env`. All secrets belong in App Platform's encrypted
  environment variables.
