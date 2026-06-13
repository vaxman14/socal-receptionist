-- 015_no_card_trial.sql
-- No-card free trial + activation method (Activate onboarding step).
--
-- The original trial was a Stripe trial gated behind checkout + the $1,500 setup
-- fee (lib/billing.js). The self-serve flow now offers a 7-day NO-CARD trial:
-- the tenant goes `active` immediately on activation with trial_ends_at set, and
-- is entitled during the trial WITHOUT a Stripe subscription. Reminder emails go
-- out 2 days before and on the day the trial ends; if no card is added, the
-- tenant is suspended (suspended_billing).
--
-- activation_method records how they chose to activate:
--   'socal_number' — self-serve, we provision a Twilio number (Essentials tier)
--   'byo_sip'      — they have their own phone system; routed to Concierge
--                    white-glove setup (sales-assisted, NOT a self-serve trial)

alter table tenants
  add column if not exists trial_ends_at             timestamptz,
  add column if not exists activation_method         text,
  add column if not exists trial_reminder_2d_sent_at timestamptz,
  add column if not exists trial_reminder_0d_sent_at timestamptz;

-- Sweep query for the reminder job hits trial_ends_at a lot; index it.
create index if not exists tenants_trial_ends_at_idx
  on tenants (trial_ends_at)
  where trial_ends_at is not null;

comment on column tenants.trial_ends_at is
  'No-card free trial expiry. Entitled while now() < trial_ends_at even without a Stripe subscription.';
comment on column tenants.activation_method is
  'socal_number | byo_sip — how the tenant activated at the Activate onboarding step.';
