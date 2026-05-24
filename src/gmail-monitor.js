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

// Returns new messages received after sinceMs (epoch ms), across all inboxes
async function getNewMessages(sinceMs) {
  const auth = getClient();
  const gmail = google.gmail({ version: 'v1', auth });

  // after: in Gmail query is in epoch seconds
  const afterSec = Math.floor(sinceMs / 1000);
  const query = `in:inbox after:${afterSec}`;

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q: query,
    maxResults: 20,
  });

  const messages = listRes.data.messages || [];
  const results = [];

  for (const { id } of messages) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id,
      format: 'metadata',
      metadataHeaders: ['From', 'To', 'Subject', 'Date'],
    });

    const headers = {};
    for (const h of (msg.data.payload?.headers || [])) {
      headers[h.name] = h.value;
    }

    results.push({
      id: msg.data.id,
      internalDate: parseInt(msg.data.internalDate || '0'),
      from: headers['From'] || '',
      to: headers['To'] || '',
      subject: headers['Subject'] || '(no subject)',
      date: headers['Date'] || '',
    });
  }

  // Sort oldest first
  return results.sort((a, b) => a.internalDate - b.internalDate);
}

module.exports = { getNewMessages };
