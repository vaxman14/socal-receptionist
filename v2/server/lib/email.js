// App-side transactional email.
//
// A thin, reusable wrapper around the Resend SDK for mail the *backend* sends
// (onboarding confirmations, etc.). Supabase Auth handles its own signup /
// password-reset mail via dashboard SMTP — that is NOT this.
//
// Graceful degradation: if RESEND_API_KEY is unset, sendEmail() logs a warning
// and no-ops. Local dev without the key (and the rest of the onboarding flow)
// never crashes — email is best-effort and must never block a request.

const { Resend } = require('resend');
const logger = require('./logger');

const FROM = process.env.EMAIL_FROM || 'SoCal Receptionist <noreply@socalreceptionist.com>';

// Lazily constructed, like the OpenAI client in lib/ai.js: build it on first
// use so routes that never send mail boot fine without the key.
let _resend;
function resendClient() {
  if (_resend) return _resend;
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) return null;
  _resend = new Resend(apiKey);
  return _resend;
}

// Send one transactional email.
//
//   sendEmail({ to, subject, html, text }) -> { ok, skipped?, id?, error? }
//
// Never throws: failures are logged and returned as { ok: false }, so callers
// can treat email as best-effort and not couple it to request success.
async function sendEmail({ to, subject, html, text } = {}) {
  if (!to || !subject || (!html && !text)) {
    logger.warn('email.send_invalid', { to: to || null, subject: subject || null });
    return { ok: false, error: 'to, subject, and html or text are required' };
  }

  const client = resendClient();
  if (!client) {
    logger.warn('email.send_skipped_no_key', { to, subject });
    return { ok: false, skipped: true };
  }

  try {
    const { data, error } = await client.emails.send({
      from: FROM,
      to,
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
    });
    if (error) {
      logger.error('email.send_failed', { to, subject, error: error.message || String(error) });
      return { ok: false, error: error.message || String(error) };
    }
    logger.info('email.sent', { to, subject, id: data && data.id });
    return { ok: true, id: data && data.id };
  } catch (err) {
    logger.error('email.send_error', { to, subject, error: err.message });
    return { ok: false, error: err.message };
  }
}

module.exports = { sendEmail };
