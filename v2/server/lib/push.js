// Expo push notifications — used to alert the dashboard app when a website
// visitor asks for a human (live chat handoff). Best-effort: a failure to push
// must never break the chat flow.

const { supabase } = require('./supabase');
const logger = require('./logger');

// Send a push to every device token belonging to a user.
async function pushToUser(userId, { title, body, data } = {}) {
  if (!userId) return;
  try {
    const { data: rows } = await supabase
      .from('push_tokens').select('token').eq('user_id', userId);
    const tokens = (rows || []).map((r) => r.token).filter((t) => /^ExponentPushToken/.test(t));
    if (!tokens.length) return;
    const messages = tokens.map((to) => ({ to, title, body, data: data || {}, sound: 'default', priority: 'high' }));
    const res = await fetch('https://exp.host/--/api/v2/push/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(messages),
    });
    if (!res.ok) logger.error('push.send_failed', { status: res.status, body: await res.text() });
  } catch (e) {
    logger.error('push.error', { error: e.message });
  }
}

module.exports = { pushToUser };
