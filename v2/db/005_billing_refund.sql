-- =============================================================================
-- SoCal Receptionist V2 — Migration 005: setup fee + 14-day refund tracking
--
-- Pricing model (set 2026-05-21): a client pays a one-time $1,500 setup fee at
-- checkout — that fee includes the first month of service — then $500/mo
-- recurring once the prepaid first month ends (a 30-day Stripe trial defers the
-- monthly charge).
--
-- If a client cancels within 14 days of paying the setup fee, $1,000 of that
-- fee is refunded automatically. To do that the billing code has to know which
-- payment to refund and when the clock started, so subscriptions gains:
--
--   * setup_payment_intent — the Stripe PaymentIntent that collected the fee.
--   * setup_paid_at        — when it was paid; start of the 14-day window.
--   * setup_refunded_at    — stamped once the $1,000 refund is issued; also the
--                            idempotency guard so the refund fires exactly once.
--
-- Apply AFTER 004_voice.sql.
-- =============================================================================

alter table subscriptions
  add column if not exists setup_payment_intent text,
  add column if not exists setup_paid_at        timestamptz,
  add column if not exists setup_refunded_at    timestamptz;
