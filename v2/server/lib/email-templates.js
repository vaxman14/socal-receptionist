// Transactional email templates.
//
// Each builder returns { subject, html, text } ready to hand to sendEmail().
// Templates are plain string builders — no template engine — to match the rest
// of the backend (see lib/agreements.js renderExecutedAgreementHtml).

const APP_BASE_URL = process.env.APP_BASE_URL || 'https://app.socalreceptionist.com';
const BRAND = 'SoCal Receptionist';

// Minimal inline-styled HTML shell. Email clients ignore <style> blocks and
// external CSS, so styling is inlined and kept deliberately simple.
function layout({ heading, bodyHtml }) {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 0;">
      <tr>
        <td align="center">
          <table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;overflow:hidden;max-width:560px;">
            <tr>
              <td style="background:#0f3d5c;padding:24px 32px;">
                <span style="color:#ffffff;font-size:18px;font-weight:700;">${BRAND}</span>
              </td>
            </tr>
            <tr>
              <td style="padding:32px;">
                <h1 style="margin:0 0 16px;font-size:22px;font-weight:700;color:#0f3d5c;">${heading}</h1>
                ${bodyHtml}
              </td>
            </tr>
            <tr>
              <td style="padding:20px 32px;background:#f4f5f7;color:#7a7a7a;font-size:12px;">
                ${BRAND} &middot; This is a transactional message about your account.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

// Sent right after a business owner registers their tenant (status
// 'onboarding'). Confirms the account was created and points them at the next
// step — signing the Service Agreement.
function onboardingConfirmation({ businessName } = {}) {
  const name = businessName || 'your business';
  const subject = `Welcome to ${BRAND} — ${name} is set up`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
      Thanks for registering <strong>${escapeHtml(name)}</strong> with ${BRAND}.
      Your account has been created.
    </p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
      The next step is to review and sign your Service Agreement. Once it's
      signed, we'll begin provisioning your receptionist line.
    </p>
    <p style="margin:24px 0;">
      <a href="${APP_BASE_URL}" style="background:#0f3d5c;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">
        Continue onboarding
      </a>
    </p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#555;">
      If you didn't create this account, you can ignore this email.
    </p>`;

  const text = [
    `Welcome to ${BRAND}`,
    '',
    `Thanks for registering ${name} with ${BRAND}. Your account has been created.`,
    '',
    "The next step is to review and sign your Service Agreement. Once it's signed,",
    "we'll begin provisioning your receptionist line.",
    '',
    `Continue onboarding: ${APP_BASE_URL}`,
    '',
    "If you didn't create this account, you can ignore this email.",
  ].join('\n');

  return { subject, html: layout({ heading: `Welcome aboard`, bodyHtml }), text };
}

// Escape user-supplied values before interpolating into HTML.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { onboardingConfirmation };
