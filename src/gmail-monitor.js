const { google } = require('googleapis');
const { JWT } = require('google-auth-library');
const config = require('./config');

const ACCOUNTS = [
  { name: 'info',    email: 'info@socalreceptionist.com' },
  { name: 'support', email: 'support@socalreceptionist.com' },
];

// Build a Gmail auth client for the given email address.
// Prefers service account with DWD (GOOGLE_SERVICE_ACCOUNT_KEY) over per-account OAuth tokens.
function getClient(email) {
  const saKey = config.gcal.serviceAccountKey;
  if (saKey) {
    const key = JSON.parse(saKey);
    return new JWT({
      email: key.client_email,
      key: key.private_key,
      scopes: [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.send',
      ],
      subject: email,
    });
  }

  // Legacy: per-account OAuth refresh tokens
  const refreshTokenMap = {
    'info@socalreceptionist.com':    config.gcal.refreshTokenInfo,
    'support@socalreceptionist.com': config.gcal.refreshTokenSupport,
  };
  const rt = refreshTokenMap[email];
  if (!rt) return null;

  const oAuth2Client = new google.auth.OAuth2(
    config.gcal.clientId,
    config.gcal.clientSecret,
    'https://www.socalreceptionist.com/auth/google-callback'
  );
  oAuth2Client.setCredentials({ refresh_token: rt });
  return oAuth2Client;
}

// Returns new messages received after sinceMs (epoch ms), across all configured inboxes
async function getNewMessages(sinceMs) {
  const afterSec = Math.floor(sinceMs / 1000);
  const query = `in:inbox after:${afterSec}`;
  const results = [];

  for (const account of ACCOUNTS) {
    const auth = getClient(account.email);
    if (!auth) continue;

    try {
      const gmail = google.gmail({ version: 'v1', auth });

      const listRes = await gmail.users.messages.list({ userId: 'me', q: query, maxResults: 20 });
      const messages = listRes.data.messages || [];

      for (const { id } of messages) {
        const msg = await gmail.users.messages.get({
          userId: 'me', id, format: 'metadata',
          metadataHeaders: ['From', 'To', 'Subject', 'Date', 'Message-ID', 'References', 'In-Reply-To'],
        });

        const headers = {};
        for (const h of (msg.data.payload?.headers || [])) headers[h.name] = h.value;

        results.push({
          id: msg.data.id,
          account: account.name,
          accountEmail: account.email,
          internalDate: parseInt(msg.data.internalDate || '0'),
          from: headers['From'] || '',
          to: headers['To'] || '',
          subject: headers['Subject'] || '(no subject)',
          date: headers['Date'] || '',
          messageId: headers['Message-ID'] || '',
          references: headers['References'] || '',
          inReplyTo: headers['In-Reply-To'] || '',
          threadId: msg.data.threadId,
        });
      }
    } catch (err) {
      console.error(`[gmail-monitor] error reading ${account.name}: ${err.message}`);
    }
  }

  return results.sort((a, b) => a.internalDate - b.internalDate);
}

// Send a reply from the given account email address
async function sendReply({ fromAccountEmail, toEmail, subject, body, inReplyToMessageId, references, threadId }) {
  const account = ACCOUNTS.find(a => a.email === fromAccountEmail);
  if (!account) throw new Error(`Unknown account: ${fromAccountEmail}`);

  const auth = getClient(fromAccountEmail);
  if (!auth) throw new Error(`No credentials for ${fromAccountEmail}`);

  const gmail = google.gmail({ version: 'v1', auth });

  const replySubject = subject.startsWith('Re:') ? subject : `Re: ${subject}`;
  const refHeader = references ? `${references} ${inReplyToMessageId}` : inReplyToMessageId;

  const rawLines = [
    `From: ${fromAccountEmail}`,
    `To: ${toEmail}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${inReplyToMessageId}`,
    `References: ${refHeader}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
  ];
  const raw = Buffer.from(rawLines.join('\r\n')).toString('base64url');

  await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId } });
}

module.exports = { getNewMessages, sendReply };
