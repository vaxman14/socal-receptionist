// Provisioning worker.
//
// Polls the provisioning_jobs queue, dispatches each due job to its handler,
// and applies retry/backoff or manual-review escalation. Single-process by
// design — read the claimDueJobs() note in lib/jobs.js before scaling out.

const HANDLERS = require('./handlers');
const { claimDueJobs, completeJob, failJob, ManualReviewRequired } = require('../lib/jobs');

// Process one batch of due jobs. Returns the number of jobs handled.
async function runOnce() {
  const jobs = await claimDueJobs();
  for (const job of jobs) {
    const handler = HANDLERS[job.job_type];
    try {
      if (!handler) {
        throw new ManualReviewRequired(`No handler registered for job_type "${job.job_type}"`);
      }
      await handler(job);
      await completeJob(job.id);
      console.log(`[worker] ${job.job_type} #${job.id} ok`);
    } catch (err) {
      const outcome = await failJob(job, err);
      console.warn(`[worker] ${job.job_type} #${job.id} ${outcome}: ${err.message}`);
    }
  }
  return jobs.length;
}

// Start the polling loop. Returns a stop() function.
function startWorker(opts = {}) {
  const intervalMs = opts.intervalMs || 5000;
  let stopped = false;
  let timer = null;

  async function tick() {
    if (stopped) return;
    try {
      await runOnce();
    } catch (err) {
      console.error('[worker] tick failed:', err.message);
    }
    if (!stopped) timer = setTimeout(tick, intervalMs);
  }
  tick();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

module.exports = { runOnce, startWorker };
