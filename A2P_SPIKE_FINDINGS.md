# Step 1 — A2P 10DLC Spike: Findings

_Run 2026-05-20. Determines whether self-serve "instant" SMS onboarding is real._

## Current Twilio account state (audited via API)

- **1 phone number:** `+18557608975` — a **toll-free** number (855), SMS-capable.
- **Toll-free verification:** status `IN_REVIEW` (SID `HH52e7a3...`) — submitted, awaiting carrier review.
- **Messaging Services:** none exist.
- **A2P Brand registrations:** none. A2P 10DLC has not been started.

> Important: V1 runs on a **toll-free** number, which uses the **Toll-Free Verification**
> path — a *different* compliance regime from A2P 10DLC (which governs local 10-digit
> long codes). V2's per-client model needs a deliberate choice between the two.

## Hard finding: "live in 15 minutes" is not achievable for compliant US SMS

- **10DLC campaign review currently takes 10–15 days** (carrier-side, not Twilio-controllable).
- Every campaign requires a public **Privacy Policy + Terms & Conditions URL**.
- ISV model: a **Primary Business Profile approved as "ISV Reseller/Partner"** in Twilio
  Trust Hub is a hard prerequisite before *any* customer can be onboarded. That approval
  itself takes time and must happen once, up front.
- Each client then needs a **Secondary Customer Profile + Brand + Campaign**.

## Verdict

The product can be **configured** in 15 minutes. Outbound US SMS on a freshly
registered number **cannot** go live in 15 minutes — carrier review is ~2 weeks.
Codex's "compliance-gated activation" reframe is confirmed by hard data, not caution.

## Recommended model

New tenant lifecycle:
1. Buy plan + configure (~15 min) → tenant status `sms_pending_compliance`.
2. Backend auto-registers a Secondary Brand + Campaign under Roman's ISV profile.
3. Carrier review (~10–15 days; faster for Sole Proprietor brands — see below).
4. On approval → status `active`, SMS goes live; notify the client.

**Sole Proprietor A2P path** is worth piloting: lower-friction, lower-volume brand
type aimed at very small businesses (exactly SoCal Receptionist's market — dentists,
plumbers, salons). Often faster/cheaper to register than Standard brands.

**Number type:** lean toward 10DLC local numbers for V2 per-client (toll-free
verification doesn't scale as cleanly for self-serve and looks less local). Decide
during prerequisite setup.

## BLOCKER — needs Roman (cannot be automated)

Registering the ISV Primary Business Profile is an outward-facing, paid, identity
action. It needs Roman's real data and explicit go-ahead:
- Legal business name, business type/structure, EIN (or Sole Prop status)
- Business address, website, contact name/email/phone
- Public Privacy Policy + Terms URLs (the SoCal Receptionist site must host these)

Once provided, this profile is registered **once**, then every client rides under it.

## Twilio docs referenced

- ISV A2P 10DLC Onboarding Overview — https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv
- ISV API onboarding (Standard / Low-Volume) — https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api
- Sole Proprietor registration for ISVs — https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/onboarding-isv-api-sole-prop-new
- Campaign approval requirements — https://help.twilio.com/articles/11847054539547-A2P-10DLC-Campaign-Approval-Requirements
- Gather required business info — https://www.twilio.com/docs/messaging/compliance/a2p-10dlc/collect-business-info
