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

// Realtime API cost estimate in cents from a response.done usage block
// (gpt-realtime: audio in $32/1M, audio out $64/1M, text in $4/1M, text out $16/1M).
function estimateRealtimeCostCents(usage) {
  if (!usage) return 0;
  const inDet = usage.input_token_details || {};
  const outDet = usage.output_token_details || {};
  const cents =
    (inDet.audio_tokens || 0) * 0.0032 +
    (inDet.text_tokens || 0) * 0.0004 +
    (inDet.cached_tokens || 0) * 0.0004 +
    (outDet.audio_tokens || 0) * 0.0064 +
    (outDet.text_tokens || 0) * 0.0016;
  return cents;
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

// Hard-cap breach: notify the tenant owner (and audit-log it) the first time
// a cap is hit in the current usage period. Subsequent blocked requests in
// the same period are silent — service simply stays off until the month rolls
// or the cap is raised. Never throws.
async function notifyCapBreach(tenant, reason) {
  try {
    const periodStart = tenant.usage_period_start || new Date().toISOString().slice(0, 8) + '01';
    const { data: existing } = await supabase
      .from('audit_log')
      .select('id')
      .eq('tenant_id', tenant.id)
      .eq('action', 'spend_cap.breached')
      .gte('created_at', new Date(periodStart).toISOString())
      .limit(1);
    if (existing && existing.length) return;

    await supabase.from('audit_log').insert({
      tenant_id: tenant.id,
      actor_type: 'system',
      action: 'spend_cap.breached',
      target_type: 'tenant',
      target_id: tenant.id,
      metadata: { reason },
    });

    const { sendEmail } = require('./email'); // late require — email.js ↔ usage.js
    const to = tenant.voicemail_email || tenant.owner_email;
    if (to) {
      await sendEmail({
        to,
        subject: `Service paused — monthly usage cap reached (${tenant.business_name})`,
        html: `<p>Your AI receptionist hit its monthly usage cap and has paused handling new calls/messages.</p><p>Service resumes automatically at the start of the next billing month, or contact us to raise the cap.</p>`,
        text: `Your AI receptionist hit its monthly usage cap and has paused handling new calls/messages. Service resumes automatically next month, or contact us to raise the cap.`,
      });
    }
  } catch (err) {
    console.error('[usage] cap breach notify failed:', err.message);
  }
}

module.exports = { estimateOpenaiCostCents, estimateRealtimeCostCents, withinCaps, recordUsage, notifyCapBreach };
