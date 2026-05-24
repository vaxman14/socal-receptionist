/**
 * One-time Google Calendar OAuth setup.
 * Run: GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/setup-gcal-auth.js
 * Visit the printed URL, authorize, and the refresh token prints in your terminal.
 */
const { google } = require('googleapis');
const http = require('http');

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = 'http://localhost:8765';
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error('Usage: GOOGLE_CLIENT_ID=xxx GOOGLE_CLIENT_SECRET=yyy node scripts/setup-gcal-auth.js');
  process.exit(1);
}

const oAuth2Client = new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);

const authUrl = oAuth2Client.generateAuthUrl({
  access_type: 'offline',
  scope: SCOPES,
  prompt: 'consent',
});

console.log('\n👉  Visit this URL in your browser:\n');
console.log(authUrl);
console.log('\nWaiting for authorization (port 8765)...\n');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, REDIRECT_URI);
  const code = url.searchParams.get('code');
  if (!code) {
    res.end('No code found. Close this tab and try again.');
    return;
  }

  try {
    const { tokens } = await oAuth2Client.getToken(code);
    res.end('<h2>Authorized! ✅ Close this tab and check your terminal.</h2>');
    server.close();

    console.log('\n✅  Authorization successful!\n');
    console.log('Add these to DigitalOcean environment variables:\n');
    console.log(`GOOGLE_CLIENT_ID=${CLIENT_ID}`);
    console.log(`GOOGLE_CLIENT_SECRET=${CLIENT_SECRET}`);
    console.log(`GOOGLE_REFRESH_TOKEN=${tokens.refresh_token}`);
    console.log('\nThen send me the three values and I\'ll add them to DO.\n');
  } catch (err) {
    res.end('Error: ' + err.message);
    console.error('Auth error:', err.message);
    server.close();
  }
});

server.listen(8765);
