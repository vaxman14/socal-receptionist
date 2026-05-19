const express = require('express');
const twilio = require('twilio');
const config = require('./src/config');
const { handleMessage } = require('./src/ai');
const { isValidTwilioRequest } = require('./src/twilio');
const consent = require('./src/consent');

const app = express();

// Required so req.protocol resolves to https behind the DigitalOcean proxy,
// which keeps Twilio signature validation correct.
app.set('trust proxy', true);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.get('/', (req, res) => {
  res.send('SoCal Receptionist is running.');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', business: config.business.name });
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
