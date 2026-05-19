const express = require('express');
const path = require('path');
const twilio = require('twilio');
const config = require('./src/config');
const { handleMessage } = require('./src/ai');
const { isValidTwilioRequest } = require('./src/twilio');
const consent = require('./src/consent');
const { notifyOwner } = require('./src/email');

const app = express();

// Required so req.protocol resolves to https behind the DigitalOcean proxy,
// which keeps Twilio signature validation correct.
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/health', (req, res) => {
  res.json({ status: 'ok', business: config.business.name });
});

// Landing page demo request form
app.post('/demo', async (req, res) => {
  const { name, business, phone, type } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Missing required fields' });

  const body =
    `New demo request from the SoCal Receptionist landing page.\n\n` +
    `Name:     ${name}\n` +
    `Business: ${business || '-'}\n` +
    `Phone:    ${phone}\n` +
    `Industry: ${type || '-'}`;

  try {
    await notifyOwner(`Demo request: ${name} — ${business || phone}`, body);
    res.json({ ok: true });
  } catch (err) {
    console.error('Demo notification email failed:', err.message);
    res.status(500).json({ error: 'Email failed' });
  }
});

app.get('/privacy', (req, res) => {
  res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SMS Privacy Policy — ${config.business.name}</title>
  <style>
    body { font-family: sans-serif; max-width: 680px; margin: 40px auto; padding: 0 20px; color: #222; line-height: 1.6; }
    h1 { font-size: 1.4rem; }
    h2 { font-size: 1.1rem; margin-top: 2rem; }
  </style>
</head>
<body>
  <h1>SMS Messaging — Consent &amp; Privacy Policy</h1>
  <p><strong>${config.business.name}</strong> provides an automated SMS receptionist service to help customers get information and schedule appointments.</p>

  <h2>How You Opt In</h2>
  <p>When you text our number, you will receive a consent prompt asking you to reply <strong>YES</strong> to receive automated messages. No messages are sent until you confirm consent.</p>

  <h2>Message Frequency</h2>
  <p>Message frequency varies based on your inquiries. Typically 1–5 messages per conversation.</p>

  <h2>How to Opt Out</h2>
  <p>Reply <strong>STOP</strong> at any time to stop receiving messages. You will receive one confirmation message and no further messages will be sent.</p>

  <h2>Help</h2>
  <p>Reply <strong>HELP</strong> for assistance, or contact us directly.</p>

  <h2>Cost</h2>
  <p>Message and data rates may apply depending on your mobile carrier plan.</p>

  <h2>Data &amp; Privacy</h2>
  <p>Your phone number and conversation content are used only to respond to your inquiries and connect you with the business. We do not sell or share your information with third parties.</p>

  <p style="margin-top:2rem; font-size:0.85rem; color:#666;">Last updated: May 2026</p>
</body>
</html>`);
});

// Twilio inbound SMS webhook. Twilio POSTs the message here and expects a
// TwiML response, which it delivers back to the customer as the outbound SMS.
app.post('/sms', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    console.warn('Rejected request: invalid Twilio signature');
    return res.status(403).send('Invalid Twilio signature');
  }

  const from = req.body.From;
  const body = (req.body.Body || '').trim();
  const twiml = new twilio.twiml.MessagingResponse();

  if (!from || !body) {
    twiml.message("Sorry, I didn't catch that. Could you resend your message?");
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  const status = consent.getStatus(from);
  const normalizedBody = body.toUpperCase();

  // Always honor STOP regardless of consent state (Twilio also handles this
  // automatically for toll-free numbers, but we track it ourselves too).
  if (normalizedBody === 'STOP' || normalizedBody === 'UNSUBSCRIBE') {
    consent.setStatus(from, 'opted_out');
    res.type('text/xml');
    return res.send(twiml.toString()); // send empty TwiML; Twilio sends its own STOP reply
  }

  if (status === 'opted_out') {
    res.type('text/xml');
    return res.send(twiml.toString()); // silently drop — they opted out
  }

  if (status === 'unknown') {
    consent.setStatus(from, 'pending');
    twiml.message(
      `Hi! You've reached ${config.business.name}. Reply YES to receive automated messages from our virtual receptionist, or STOP to opt out. Msg & data rates may apply.`
    );
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  if (status === 'pending') {
    if (normalizedBody === 'YES' || normalizedBody === 'Y') {
      consent.setStatus(from, 'opted_in');
      twiml.message(`You're all set! How can I help you today?`);
    } else {
      twiml.message(`Reply YES to continue or STOP to opt out.`);
    }
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  // status === 'opted_in' — hand off to AI
  try {
    const reply = await handleMessage(from, body);
    twiml.message(reply);
  } catch (err) {
    console.error('Error handling inbound SMS:', err);
    twiml.message(
      `Thanks for contacting ${config.business.name}! We're having a brief technical hiccup — someone will follow up with you shortly.`
    );
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

app.listen(config.port, () => {
  console.log(
    `SoCal Receptionist for "${config.business.name}" listening on port ${config.port}`
  );
});
