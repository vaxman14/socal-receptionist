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

// Step 2 — purchase a local voice number and wire webhooks.
// SMS/A2P is deferred; this step provisions voice-only and is idempotent.
async function setupMessaging(job) {
  // If the tenant already has a number, skip straight to finalize.
  const { data: existing } = await supabase
    .from('phone_numbers')
    .select('id')
    .eq('tenant_id', job.tenant_id)
    .limit(1);
  if (existing && existing.length > 0) {
    await enqueue(job.tenant_id, 'finalize_onboarding', {});
    return;
  }

  const baseUrl = process.env.API_PUBLIC_BASE_URL || process.env.APP_BASE_URL || 'https://socal-receptionist-v2-spbrw.ondigitalocean.app';

  // Search for a local number — try 951 (Murrieta/Temecula) first, then any CA, then any US.
  let phoneNumber = null;
  const searches = [
    { areaCode: '951', limit: 5 },
    { inRegion: 'CA', limit: 5 },
    { limit: 5 },
  ];
  for (const params of searches) {
    try {
      const results = await twilioClient.availablePhoneNumbers('US').local.list({ ...params, voiceEnabled: true });
      if (results.length > 0) { phoneNumber = results[0].phoneNumber; break; }
    } catch { /* try next */ }
  }

  if (!phoneNumber) {
    throw new ManualReviewRequired(`Could not find an available Twilio number for tenant ${job.tenant_id}`);
  }

  // Buy it.
  const purchased = await twilioClient.incomingPhoneNumbers.create({
    phoneNumber,
    voiceUrl: `${baseUrl}/voice`,
    voiceMethod: 'POST',
    voiceFallbackUrl: `${baseUrl}/voice`,
    voiceFallbackMethod: 'POST',
    smsUrl: `${baseUrl}/sms`,
    smsMethod: 'POST',
    friendlyName: `SoCal Receptionist — ${job.tenant_id}`,
  });

  // Save to DB.
  const { error: dbErr } = await supabase.from('phone_numbers').insert({
    tenant_id: job.tenant_id,
    phone_e164: purchased.phoneNumber,
    twilio_sid: purchased.sid,
    status: 'active',
    number_type: 'local_10dlc',
  });
  if (dbErr) {
    await twilioClient.incomingPhoneNumbers(purchased.sid).remove().catch(() => {});
    throw dbErr;
  }

  console.log(`[worker] provisioned ${purchased.phoneNumber} for tenant ${job.tenant_id}`);
  await enqueue(job.tenant_id, 'finalize_onboarding', {});

  // A2P 10DLC: attach the number to the platform Messaging Service so it is
  // covered by the registered campaign. Runs as its own job so a pending
  // campaign approval retries without re-buying numbers or blocking go-live.
  if (process.env.TWILIO_MESSAGING_SERVICE_SID) {
    await enqueue(job.tenant_id, 'a2p_attach_number', { phone_number_sid: purchased.sid });
  }
}

// Attach a purchased number to the platform's A2P-registered Messaging Service.
// Twilio rejects this while the campaign is unapproved — the job retries with
// backoff and escalates to manual review after max attempts.
async function a2pAttachNumber(job) {
  const serviceSid = process.env.TWILIO_MESSAGING_SERVICE_SID;
  if (!serviceSid) return; // SMS not enabled platform-wide — nothing to do

  const phoneNumberSid = job.payload && job.payload.phone_number_sid;
  if (!phoneNumberSid) {
    throw new ManualReviewRequired('a2p_attach_number job missing payload.phone_number_sid');
  }

  try {
    await twilioClient.messaging.v1.services(serviceSid).phoneNumbers.create({ phoneNumberSid });
  } catch (err) {
    // 21712: number already in this service — idempotent success.
    if (err.code === 21712) return;
    throw err;
  }

  await supabase
    .from('phone_numbers')
    .update({ number_type: 'local_10dlc' })
    .eq('tenant_id', job.tenant_id)
    .eq('twilio_sid', phoneNumberSid);

  console.log(`[worker] attached ${phoneNumberSid} to messaging service ${serviceSid} (tenant ${job.tenant_id})`);
}

// Step 3 — flip the tenant live and auto-start the 7-day no-card trial.
async function finalizeOnboarding(job) {
  const { data: numbers, error } = await supabase
    .from('phone_numbers')
    .select('status')
    .eq('tenant_id', job.tenant_id);
  if (error) throw error;

  const hasActiveNumber = (numbers || []).some((n) => n.status === 'active');
  const next = hasActiveNumber ? 'active' : 'active'; // voice-only, no SMS compliance gate

  await transitionTenant(job.tenant_id, next, {
    reason: 'onboarding pipeline complete',
    metadata: { job_id: job.id },
  });

  // Auto-start 7-day no-card trial if no subscription exists yet.
  const { data: existingSub } = await supabase
    .from('subscriptions')
    .select('id')
    .eq('tenant_id', job.tenant_id)
    .limit(1);

  if (!existingSub || existingSub.length === 0) {
    const trialEnd = new Date();
    trialEnd.setDate(trialEnd.getDate() + 7);
    const trialEndIso = trialEnd.toISOString();

    await supabase.from('subscriptions').insert({
      tenant_id: job.tenant_id,
      status: 'trialing',
      trial_ends_at: trialEndIso,
      current_period_end: trialEndIso,
      cancel_at_period_end: false,
    });
    console.log(`[worker] started 7-day trial for tenant ${job.tenant_id}, ends ${trialEndIso}`);
  }
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
  a2p_attach_number: a2pAttachNumber,
  finalize_onboarding: finalizeOnboarding,
  release_number: releaseNumber,
  purge_transcripts: purgeTranscripts,
};
