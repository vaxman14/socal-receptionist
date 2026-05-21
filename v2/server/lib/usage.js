// Per-tenant usage tracking + spend caps (Codex hardening).
//
// Counters live on the tenants row and reset monthly. record_tenant_usage()
// (db/001_init.sql) performs the period-roll + increment atomically so
// concurrent SMS handling can't lose writes.

const { supabase } = require('./supabase');

// Rough OpenAI cost estimate in cents (gpt-4o blended pricing:
// ~$2.50 / 1M input tokens, ~$10 / 1M output tokens).
function estimateOpenaiCostCents(promptTokens, completionTokens) {
  const cents = (promptTokens || 0) * 0.00025 + (completionTokens || 0) * 0.001;
  return Math.ceil(cents);
}

// Check a tenant against its monthly caps. The tenant row may be slightly
// stale (cached) — acceptable for a soft cap. Returns { ok, reason }.
function withinCaps(tenant) {
  if (
    tenant.sms_spend_cap_cents != null &&
    tenant.monthly_sms_spend_cents >= tenant.sms_spend_cap_cents
  ) {
    return { ok: false, reason: 'sms_spend_cap' };
  }
  if (
    tenant.openai_spend_cap_cents != null &&
    tenant.monthly_openai_spend_cents >= tenant.openai_spend_cap_cents
  ) {
    return { ok: false, reason: 'openai_spend_cap' };
  }
  return { ok: true, reason: null };
}

// Add usage to a tenant's monthly counters (atomic period-roll + increment).
async function recordUsage(tenantId, opts) {
  const { smsCount = 0, smsCostCents = 0, openaiCostCents = 0 } = opts || {};
  const { error } = await supabase.rpc('record_tenant_usage', {
    p_tenant: tenantId,
    p_sms: smsCount,
    p_sms_cents: smsCostCents,
    p_openai_cents: openaiCostCents,
  });
  if (error) throw error;
}

module.exports = { estimateOpenaiCostCents, withinCaps, recordUsage };
