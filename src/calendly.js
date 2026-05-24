const config = require('./config');

let cachedUrl = null;

async function getSchedulingUrl() {
  if (cachedUrl) return cachedUrl;

  const token = config.calendly.apiToken;
  if (!token) return null;

  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  try {
    const meRes = await fetch('https://api.calendly.com/users/me', { headers });
    if (!meRes.ok) throw new Error(`Calendly /users/me ${meRes.status}`);
    const me = await meRes.json();
    const userUri = me.resource.uri;

    const etRes = await fetch(
      `https://api.calendly.com/event_types?user=${encodeURIComponent(userUri)}&count=20`,
      { headers }
    );
    if (!etRes.ok) throw new Error(`Calendly /event_types ${etRes.status}`);
    const et = await etRes.json();

    const active = (et.collection || []).find(e => e.active);
    if (!active) return null;

    cachedUrl = active.scheduling_url;
    return cachedUrl;
  } catch (err) {
    console.error('[calendly] getSchedulingUrl error:', err.message);
    return null;
  }
}

async function sendBookingLink(toNumber, schedulingUrl) {
  if (!toNumber || !schedulingUrl) return { success: false, error: 'missing args' };

  const twilio = require('twilio');
  const client = twilio(config.twilio.accountSid, config.twilio.authToken);
  const from = config.twilio.salesNumber || config.twilio.phoneNumber;

  try {
    await client.messages.create({
      body: `Hi! Book your 30-min demo with Roman at SoCal Receptionist here: ${schedulingUrl}`,
      from,
      to: toNumber,
    });
    return { success: true };
  } catch (err) {
    console.error('[calendly] sendBookingLink error:', err.message);
    return { success: false, error: err.message };
  }
}

module.exports = { getSchedulingUrl, sendBookingLink };
