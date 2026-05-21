// Entry point for the provisioning worker process.
//
//   node server/provisioning/run-worker.js   (or: npm run worker)

require('dotenv').config();
const { startWorker } = require('./worker');

const intervalMs = Number(process.env.WORKER_INTERVAL_MS) || 5000;
const stop = startWorker({ intervalMs });
console.log(`[worker] provisioning worker started (poll every ${intervalMs}ms)`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    console.log(`[worker] ${signal} received — shutting down`);
    stop();
    process.exit(0);
  });
}
