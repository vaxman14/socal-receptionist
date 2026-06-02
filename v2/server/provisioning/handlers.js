// Provisioning job handlers.
//
// A handler is `async (job) => void`. It runs inside the worker:
//   * returning normally       -> job marked 'succeeded'
//   * throwing                 -> retry with backoff (see lib/jobs.failJob)
//   * throwing ManualReviewRequired -> escalates straight to 'needs_review'
//
// Onboarding pipeline (each step enqueues the next on success, so the chain is
// restartable from any point and every step is independently retryable):
//
//   provision_tenant -> setup_messaging -> finalize_onboarding

const twilio = require('twilio');
const { supabase } = require('../lib/supabase');
const { enqueue, ManualReviewRequired } = require('../lib/jobs');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);
const { transitionTenant } = require('../lib/state-machine');
const { hasSignedCurrent } = require('../lib/agreements');

// Step 1 — verify the tenant has the config needed to provision, then kick off
// the Twilio/SMS setup step.
async function provisionTenant(job) {
  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('id, status, business_name, business_hours, business_services, owner_email')
    .eq('id', job.tenant_id)
    .single();
  if (error) throw error;

  // Already past onboarding — pipeline ran before. Idempotent no-op.
  if (tenant.status !== 'onboarding') return;

  const missing = ['business_name', 'owner_email']
    .filter((field) => !tenant[field]);
  if (missing.length) {
    throw new ManualReviewRequired(
      `Tenant ${tenant.id} cannot provision — missing config: ${missing.join(', ')}`
    );
  }

  // Hard gate: a signed Service Agreement is a precondition for service.
  // Provisioning is normally enqueued by the signing endpoint, so reaching
  // here unsigned means the pipeline was started out of order — escalate.
  if (!(await hasSignedCurrent(tenant.id))) {
    throw new ManualReviewRequired(
      `Tenant ${tenant.id} cannot provision — Service Agreement not signed.`
    );
  }

  await enqueue(job.tenant_id, 'setup_messaging', {});
}

// Step 2 — Twilio side: create/attach a Messaging Service + sender number and
// register the A2P brand + campaign.
//
// STUB pending ISV registration. The A2P spike (A2P_SPIKE_FINDINGS.md) found no
// Trust Hub ISV Primary Profile yet; that registration is outward-facing, paid,
// and needs Roman's legal business info, so it cannot be automated. Once the
// ISV profile exists this handler will:
//   1. create or reuse the tenant's Twilio Messaging Service,
//   2. purchase or attach a sender number -> insert into `phone_numbers`,
//   3. submit the A2P brand + campaign (Sole Proprietor path for small biz),
//   4. enqueue `finalize_onboarding`.
async function setupMessaging(job) {
  // Voice-first launch gate. While SMS is dark platform-wide (SMS_ENABLED
  // false — the default), there is no Twilio messaging to set up: skip this
  // step cleanly and hand straight to finalize_onboarding so the onboarding
  // pipeline still completes (the tenant goes live voice-only).
  if (process.env.SMS_ENABLED !== 'true') {
    await enqueue(job.tenant_id, 'finalize_onboarding', {});
    return;
  }

  throw new ManualReviewRequired(
    'Twilio A2P / Messaging setup is not yet automatable — pending ISV Trust Hub ' +
      'registration (see A2P_SPIKE_FINDINGS.md). Provision this tenant manually, ' +
      'then enqueue a finalize_onboarding job.'
  );
}

// Step 3 — flip the tenant live. Outbound US SMS stays compliance-gated until
// the A2P campaign clears carrier review (~10-15 days), so onboarding completes
// into `sms_pending_compliance` unless an active number already exists.
async function finalizeOnboarding(job) {
  const { data: numbers, error } = await supabase
    .from('phone_numbers')
    .select('status')
    .eq('tenant_id', job.tenant_id);
  if (error) throw error;

  const hasActiveNumber = (numbers || []).some((n) => n.status === 'active');
  const next = hasActiveNumber ? 'active' : 'sms_pending_compliance';

  await transitionTenant(job.tenant_id, next, {
    reason: 'onboarding pipeline complete',
    metadata: { job_id: job.id },
  });
}

// Release a tenant's phone number — marks the row released and (in production)
// releases the number back to Twilio. The Twilio REST call is a stub pending
// the live integration; the DB side is real so the number frees up internally.
async function releaseNumber(job) {
  const numberId = job.payload && job.payload.phone_number_id;
  if (!numberId) {
    throw new ManualReviewRequired('release_number job missing payload.phone_number_id');
  }

  // Fetch the number record for the Twilio SID and BYO flag.
  const { data: numRow, error: fetchErr } = await supabase
    .from('phone_numbers')
    .select('id, twilio_sid, is_byo, status')
    .eq('id', numberId)
    .eq('tenant_id', job.tenant_id)
    .maybeSingle();
  if (fetchErr) throw fetchErr;
  if (!numRow) return; // already gone

  // Release from Twilio unless it's a bring-your-own number.
  if (!numRow.is_byo && numRow.twilio_sid) {
    try {
      await twilioClient.incomingPhoneNumbers(numRow.twilio_sid).remove();
      console.log(`[worker] released Twilio number ${numRow.twilio_sid} for tenant ${job.tenant_id}`);
    } catch (err) {
      // If Twilio says the number doesn't exist, treat as already released.
      if (err.code !== 20404) throw err;
      console.warn(`[worker] Twilio number ${numRow.twilio_sid} already absent (20404), marking released`);
    }
  }

  const { error } = await supabase
    .from('phone_numbers')
    .update({ status: 'released', released_at: new Date().toISOString() })
    .eq('id', numberId)
    .eq('tenant_id', job.tenant_id);
  if (error) throw error;
}

// Purge transcript messages past a tenant's retention window.
async function purgeTranscripts(job) {
  const retainDays = (job.payload && job.payload.retain_days) || 365;
  const { purgeOldMessages } = require('../lib/retention');
  const removed = await purgeOldMessages(job.tenant_id, retainDays);
  console.log(`[worker] purged ${removed} messages for tenant ${job.tenant_id}`);
}

// job_type -> handler registry. The worker dispatches off these keys.
module.exports = {
  provision_tenant: provisionTenant,
  setup_messaging: setupMessaging,
  finalize_onboarding: finalizeOnboarding,
  release_number: releaseNumber,
  purge_transcripts: purgeTranscripts,
};
