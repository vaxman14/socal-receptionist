// Entry point for the provisioning worker process.
//
//   node server/provisioning/run-worker.js   (or: npm run worker)

require('dotenv').config();
const { startWorker } = require('./worker');
const { startTrialSweep } = require('./trial-sweep');

const intervalMs = Number(process.env.WORKER_INTERVAL_MS) || 5000;
const stop = startWorker({ intervalMs });
console.log(`[worker] provisioning worker started (poll every ${intervalMs}ms)`);

// No-card trial lifecycle: reminders before expiry + suspension after. Runs in
// the same process as the job worker (single-process model).
const sweepMs = Number(process.env.TRIAL_SWEEP_INTERVAL_MS) || 15 * 60 * 1000;
const stopSweep = startTrialSweep({ intervalMs: sweepMs });
console.log(`[worker] trial sweep started (every ${Math.round(sweepMs / 60000)}m)`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log(`[worker] ${signal} received — shutting down`);
    stop();
    stopSweep();
    process.exit(0);
  });
}
