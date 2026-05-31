'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const LOG_DIR = path.join(os.homedir(), '.socal-desktop');
const LOG_FILE = path.join(LOG_DIR, 'activity-log.json');
const POLL_INTERVAL_MS = 60_000;

let intervalId = null;

function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
  }
}

function readLog() {
  ensureLogDir();
  if (!fs.existsSync(LOG_FILE)) return [];
  try {
    return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function writeEntry(entry) {
  ensureLogDir();
  const log = readLog();
  log.push(entry);
  // Keep last 1000 entries to avoid unbounded growth
  const trimmed = log.slice(-1000);
  fs.writeFileSync(LOG_FILE, JSON.stringify(trimmed, null, 2), 'utf8');
}

async function poll(onActivity) {
  let activeWin;
  try {
    // active-win is an ESM-only package in v8+; use dynamic import
    const mod = await import('active-win');
    activeWin = mod.default || mod.activeWin || mod;
  } catch (err) {
    console.error('[screen-tracker] active-win import failed:', err.message);
    return;
  }

  try {
    const result = await activeWin();
    if (!result) return;

    const entry = {
      ts: new Date().toISOString(),
      app: result.owner?.name || result.title || 'Unknown',
      title: result.title || '',
      bundleId: result.owner?.bundleId || null,
    };

    writeEntry(entry);
    if (typeof onActivity === 'function') onActivity(entry);
  } catch (err) {
    console.error('[screen-tracker] poll error:', err.message);
  }
}

function start(onActivity) {
  if (intervalId) return; // already running
  ensureLogDir();
  // Poll immediately on start, then every 60 s
  poll(onActivity);
  intervalId = setInterval(() => poll(onActivity), POLL_INTERVAL_MS);
}

function stop() {
  if (intervalId) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

function getRecentEntries(n = 5) {
  const log = readLog();
  return log.slice(-n);
}

module.exports = { start, stop, getRecentEntries, LOG_FILE };
