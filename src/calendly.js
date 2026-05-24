const config = require('./config');

let cachedEventTypeUri = null;
let cachedSchedulingUrl = null;

async function fetchEventType() {
  if (cachedEventTypeUri) return { uri: cachedEventTypeUri, url: cachedSchedulingUrl };

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

    cachedEventTypeUri = active.uri;
    cachedSchedulingUrl = active.scheduling_url;
    return { uri: cachedEventTypeUri, url: cachedSchedulingUrl };
  } catch (err) {
    console.error('[calendly] fetchEventType error:', err.message);
    return null;
  }
}

function formatSlotLabel(isoStart) {
  const d = new Date(isoStart);
  return d.toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
    timeZoneName: 'short',
  });
}

async function getAvailableTimes(count = 3) {
  const et = await fetchEventType();
  if (!et) return [];

  const token = config.calendly.apiToken;
  const headers = {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  };

  // Look ahead 7 days
  const start = new Date();
  start.setHours(start.getHours() + 2); // earliest is 2h from now
  const end = new Date(start);
  end.setDate(end.getDate() + 7);

  try {
    const url = `https://api.calendly.com/event_type_available_times` +
      `?event_type=${encodeURIComponent(et.uri)}` +
      `&start_time=${start.toISOString()}` +
      `&end_time=${end.toISOString()}`;
    const res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`Calendly /event_type_available_times ${res.status}`);
    const data = await res.json();

    return (data.collection || [])
      .filter(s => s.status === 'available')
      .slice(0, count)
      .map(s => ({
        start: s.start_time,
        label: formatSlotLabel(s.start_time),
      }));
  } catch (err) {
    console.error('[calendly] getAvailableTimes error:', err.message);
    return [];
  }
}

async function getSchedulingUrl() {
  const et = await fetchEventType();
  return et ? et.url : null;
}

module.exports = { getAvailableTimes, getSchedulingUrl };
