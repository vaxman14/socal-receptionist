const { getNewMessages } = require('./gmail-monitor');
const { sendTelegram } = require('./telegram');

const POLL_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
let lastCheckedMs = Date.now();
let pollTimer = null;

async function checkEmails() {
  const sinceMs = lastCheckedMs;
  lastCheckedMs = Date.now();

  let messages;
  try {
    messages = await getNewMessages(sinceMs);
  } catch (err) {
    console.error('[email-poller] getNewMessages failed:', err.message);
    return;
  }

  if (!messages.length) {
    console.log(`[email-poller] no new messages since ${new Date(sinceMs).toISOString()}`);
    return;
  }

  console.log(`[email-poller] ${messages.length} new message(s)`);

  for (const msg of messages) {
    const text =
      `📧 *New email* → ${msg.accountEmail}\n` +
      `*From:* ${escMd(msg.from)}\n` +
      `*Subject:* ${escMd(msg.subject)}\n` +
      `*Date:* ${escMd(msg.date)}`;

    try {
      await sendTelegram(text);
    } catch (err) {
      console.error('[email-poller] telegram notify failed:', err.message);
    }
  }
}

function escMd(str) {
  return (str || '').replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

function start() {
  if (pollTimer) return;
  console.log('[email-poller] started, polling every 30 min');
  // First check after 1 min so startup completes first
  setTimeout(() => {
    checkEmails();
    pollTimer = setInterval(checkEmails, POLL_INTERVAL_MS);
  }, 60_000);
}

function stop() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

module.exports = { start, stop, checkEmails };
