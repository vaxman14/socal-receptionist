// Provisioning job queue.
//
// Backs the tenant state machine: long-running / failure-prone steps (number
// purchase, A2P registration, Messaging Service wiring) run here asynchronously
// with retries + exponential backoff — never inline in a Stripe/Twilio webhook
// (Codex review #2). The queue table is `provisioning_jobs` (db/001_init.sql).

const { supabase } = require('./supabase');

const BACKOFF_BASE_SECONDS = 60;
const BACKOFF_MAX_SECONDS = 3600;

// A handler throws this to escalate a job straight to the manual review queue,
// skipping the remaining retry attempts (e.g. bad config, blocked dependency).
class ManualReviewRequired extends Error {
  constructor(message) {
    super(message);
    this.name = 'ManualReviewRequired';
  }
}

function backoffSeconds(attempts) {
  const exp = BACKOFF_BASE_SECONDS * 2 ** Math.max(0, attempts - 1);
  return Math.min(exp, BACKOFF_MAX_SECONDS);
}

// Add a job to the queue. `runAfter` delays first execution.
async function enqueue(tenantId, jobType, payload = {}, opts = {}) {
  const { runAfter = new Date(), maxAttempts = 5 } = opts;
  const { data, error } = await supabase
    .from('provisioning_jobs')
    .insert({
      tenant_id: tenantId,
      job_type: jobType,
      payload,
      max_attempts: maxAttempts,
      run_after: new Date(runAfter).toISOString(),
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Claim up to `limit` due jobs, marking each 'running' and bumping `attempts`.
//
// NOTE: select-then-update is race-safe only for a SINGLE worker process — the
// V2 deployment model. Before running multiple workers, replace this with a
// SECURITY DEFINER Postgres function using `FOR UPDATE SKIP LOCKED`.
async function claimDueJobs(limit = 5) {
  const { data: due, error } = await supabase
    .from('provisioning_jobs')
    .select('*')
    .eq('status', 'pending')
    .lte('run_after', new Date().toISOString())
    .order('run_after', { ascending: true })
    .limit(limit);
  if (error) throw error;

  const claimed = [];
  for (const job of due || []) {
    const { data, error: upErr } = await supabase
      .from('provisioning_jobs')
      .update({ status: 'running', attempts: job.attempts + 1 })
      .eq('id', job.id)
      .eq('status', 'pending') // lost-race guard
      .select()
      .single();
    if (!upErr && data) claimed.push(data);
  }
  return claimed;
}

async function completeJob(jobId) {
  const { error } = await supabase
    .from('provisioning_jobs')
    .update({ status: 'succeeded', last_error: null })
    .eq('id', jobId);
  if (error) throw error;
}

// Fail a running job. Retries with backoff until max_attempts is reached, then
// escalates to the manual review queue ('needs_review'). A ManualReviewRequired
// error escalates immediately, regardless of attempts.
async function failJob(job, err) {
  const message = (err && err.message) || String(err);
  const escalate = err instanceof ManualReviewRequired || job.attempts >= job.max_attempts;

  const patch = escalate
    ? { status: 'needs_review', last_error: message }
    : {
        status: 'pending',
        last_error: message,
        run_after: new Date(Date.now() + backoffSeconds(job.attempts) * 1000).toISOString(),
      };

  const { error } = await supabase.from('provisioning_jobs').update(patch).eq('id', job.id);
  if (error) throw error;
  return escalate ? 'needs_review' : 'retry';
}

module.exports = {
  ManualReviewRequired,
  enqueue,
  claimDueJobs,
  completeJob,
  failJob,
  backoffSeconds,
};
