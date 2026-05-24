const { google } = require('googleapis');
const config = require('./config');

function getClient() {
  const oAuth2Client = new google.auth.OAuth2(
    config.gcal.clientId,
    config.gcal.clientSecret,
    'http://localhost:8765'
  );
  oAuth2Client.setCredentials({ refresh_token: config.gcal.refreshToken });
  return oAuth2Client;
}

async function createDemoEvent({ callerName, callerEmail, startIso }) {
  const auth = getClient();
  const calendar = google.calendar({ version: 'v3', auth });

  const start = new Date(startIso);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  const event = {
    summary: `SoCal Receptionist Demo — ${callerName}`,
    description: `30-minute demo booked by AI receptionist.\n\nProspect: ${callerName}\nContact: ${callerEmail}`,
    start: { dateTime: start.toISOString(), timeZone: 'America/Los_Angeles' },
    end: { dateTime: end.toISOString(), timeZone: 'America/Los_Angeles' },
    attendees: [{ email: callerEmail, displayName: callerName }],
    reminders: { useDefault: true },
  };

  const res = await calendar.events.insert({
    calendarId: 'primary',
    resource: event,
    sendUpdates: 'all',
  });

  console.log(`[gcal] event created: ${res.data.htmlLink}`);
  return res.data;
}

module.exports = { createDemoEvent };
