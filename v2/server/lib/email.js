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

const FROM = process.env.EMAIL_FROM || 'SoCal Receptionist <hello@noreply.socalreceptionist.com>';

const IS_PROD = process.env.NODE_ENV === 'production';

// In production a missing key means onboarding/lead/MFA mail is silently
// dropped — that's an incident, not a degradation. Scream at boot.
if (IS_PROD && !process.env.RESEND_API_KEY) {
  logger.error('email.missing_api_key', {
    message: 'RESEND_API_KEY is not set in production — ALL transactional email (onboarding, leads, MFA) will be dropped',
  });
}

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
async function sendEmail({ to, subject, html, text, fromName } = {}) {
  if (!to || !subject || (!html && !text)) {
    logger.warn('email.send_invalid', { to: to || null, subject: subject || null });
    return { ok: false, error: 'to, subject, and html or text are required' };
  }

  const client = resendClient();
  if (!client) {
    // Error-level in prod so it pages/aggregates; warn in dev where it's expected.
    logger[IS_PROD ? 'error' : 'warn']('email.send_skipped_no_key', { to, subject });
    return { ok: false, skipped: true };
  }

  // Optional per-tenant sender display name. Keeps SoCal's verified sending
  // address/domain (clients can't send from their own unverified domain) but
  // shows their name in the inbox: "Vaxman Law <hello@noreply.socalreceptionist.com>".
  let from = FROM;
  if (fromName) {
    const m = FROM.match(/<([^>]+)>/);
    from = `${fromName} <${m ? m[1] : FROM}>`;
  }

  try {
    const { data, error } = await client.emails.send({
      from,
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

// Wrap content in the SoCal Receptionist branded shell: orange header with the
// white logo, white card body, and a footer. Email-safe (table layout, inline
// styles, hosted logo URL). `heading` is the big title, `bodyHtml` the inner
// content, `preview` the inbox preview snippet.
const BRAND_ORANGE = '#f47c20';
const LOGO_URL = 'https://www.socalreceptionist.com/images/logo-white.png';

const DEFAULT_FOOTER = `<strong style="color:#6b7280;">SoCal Receptionist</strong> &nbsp;·&nbsp; Murrieta, CA<br>` +
  `<a href="https://www.socalreceptionist.com" style="color:${BRAND_ORANGE};text-decoration:none;">socalreceptionist.com</a> &nbsp;·&nbsp; (951) 477-6060`;

// Per-tenant branding: pass logoUrl / brandColor / businessName to white-label
// the email for a client. With none passed it falls back to SoCal Receptionist.
// Header precedence: tenant logo image → tenant business-name text → SoCal logo.
function brandedEmail({ heading = '', bodyHtml = '', preview = '', footer, logoUrl, brandColor, businessName } = {}) {
  const color = brandColor || BRAND_ORANGE;
  const header = logoUrl
    ? `<img src="${logoUrl}" alt="${businessName || 'SoCal Receptionist'}" height="34" style="height:34px;max-height:44px;display:inline-block;border:0;">`
    : businessName
      ? `<span style="color:#ffffff;font-size:19px;font-weight:700;letter-spacing:.2px;">${businessName}</span>`
      : `<img src="${LOGO_URL}" alt="SoCal Receptionist" height="32" style="height:32px;display:inline-block;border:0;">`;
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f4f5f7;-webkit-font-smoothing:antialiased;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">${preview}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:24px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #ececf1;">
        <tr><td style="background:${color};padding:22px 28px;text-align:center;">${header}</td></tr>
        ${heading ? `<tr><td style="padding:30px 28px 0;color:#1a1a2e;font-size:20px;font-weight:700;">${heading}</td></tr>` : ''}
        <tr><td style="padding:16px 28px 30px;color:#374151;font-size:15px;line-height:1.6;">${bodyHtml}</td></tr>
        <tr><td style="padding:18px 28px;border-top:1px solid #f0f0f3;color:#9499a3;font-size:12px;line-height:1.5;text-align:center;">
          ${footer || DEFAULT_FOOTER}
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;
}

// Pull branding params from a tenant row (for tenant-customer-facing emails).
function tenantBrand(tenant) {
  if (!tenant) return {};
  return {
    logoUrl:      tenant.email_logo_url || undefined,
    brandColor:   tenant.email_brand_color || undefined,
    businessName: tenant.business_name || undefined,
  };
}

module.exports = { sendEmail, brandedEmail, tenantBrand };
