const twilio = require('twilio');
const config = require('./config');

const client = twilio(config.twilio.accountSid, config.twilio.authToken);

// Outbound SMS via the Twilio REST API. The conversational reply is sent
// synchronously as TwiML from the webhook; this helper is available for any
// additional out-of-band messages (e.g. a separate confirmation text).
async function sendSms(to, body) {
  return client.messages.create({
    from: config.twilio.phoneNumber,
    to,
    body,
  });
}

// Initiate an outbound call. `url` must be a publicly reachable TwiML endpoint
// that Twilio will POST to when the call connects.
async function makeOutboundCall(to, url) {
  return client.calls.create({
    to,
    from: config.twilio.phoneNumber,
    url,
  });
}

// Verifies the request genuinely came from Twilio. The app runs behind the
// DigitalOcean proxy, so `req.protocol` resolves to https only because
// `trust proxy` is enabled in server.js.
function isValidTwilioRequest(req) {
  if (!config.twilio.validateSignature) return true;
  const signature = req.header('X-Twilio-Signature') || '';
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`;
  return twilio.validateRequest(config.twilio.authToken, signature, url, req.body);
}

module.exports = { sendSms, makeOutboundCall, isValidTwilioRequest };
