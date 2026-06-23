// Transactional email templates.
//
// Each builder returns { subject, html, text } ready to hand to sendEmail().
// Templates are plain string builders — no template engine — to match the rest
// of the backend (see lib/agreements.js renderExecutedAgreementHtml).

// Links in email should land on the web app, not the API host.
const APP_BASE_URL = process.env.WEB_BASE_URL || process.env.APP_BASE_URL || 'https://app.socalreceptionist.com';
const BRAND = 'SoCal Receptionist';
const { brandedEmail } = require('./email');

// Delegate to the canonical branded shell (logo header + card + footer) so every
// transactional email shares one look. `footer` overrides the default contact
// line (used for per-tenant emails).
function layout({ heading, bodyHtml, footer }) {
  return brandedEmail({ heading, bodyHtml, footer });
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

// No-card trial reminder. Sent twice by the trial sweep (provisioning/
// trial-sweep.js): once ~2 days before the trial ends, and again on the final
// day. `daysLeft` (0, 1, or 2) drives the urgency of the copy; the CTA always
// points at the Billing page so the owner can add a card and subscribe.
function trialReminder({ businessName, daysLeft, trialEndsAt } = {}) {
  const name = businessName || 'your business';
  const billingUrl = `${APP_BASE_URL}/billing`;
  const endDate = trialEndsAt
    ? new Date(trialEndsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
    : null;

  const lastDay = (daysLeft || 0) <= 1;
  const subject = lastDay
    ? `Your ${BRAND} trial ends today — add a card to keep your receptionist`
    : `${daysLeft} days left on your ${BRAND} free trial`;

  const lead = lastDay
    ? `Your free trial for <strong>${escapeHtml(name)}</strong> ends today${endDate ? ` (${endDate})` : ''}. ` +
      `To keep your AI receptionist answering calls without interruption, add a payment method and start your subscription now.`
    : `Your free trial for <strong>${escapeHtml(name)}</strong> ends in ${daysLeft} days${endDate ? ` (${endDate})` : ''}. ` +
      `Add a payment method to keep your AI receptionist live once the trial wraps up.`;

  const bodyHtml = `
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">${lead}</p>
    <p style="margin:0 0 16px;font-size:15px;line-height:1.6;">
      The Essentials plan is <strong>$500/mo</strong> with no setup fee. You can
      cancel anytime from your billing portal.
    </p>
    <p style="margin:24px 0;">
      <a href="${billingUrl}" style="background:#0f3d5c;color:#ffffff;text-decoration:none;padding:12px 24px;border-radius:8px;font-size:15px;font-weight:600;display:inline-block;">
        Add a card &amp; subscribe
      </a>
    </p>
    <p style="margin:0;font-size:14px;line-height:1.6;color:#555;">
      Questions? Just reply to this email and we'll help you out.
    </p>`;

  const text = [
    lastDay ? `Your ${BRAND} trial ends today` : `${daysLeft} days left on your ${BRAND} trial`,
    '',
    lastDay
      ? `Your free trial for ${name} ends today${endDate ? ` (${endDate})` : ''}. Add a payment method now to keep your AI receptionist answering calls.`
      : `Your free trial for ${name} ends in ${daysLeft} days${endDate ? ` (${endDate})` : ''}. Add a payment method to keep your AI receptionist live.`,
    '',
    'The Essentials plan is $500/mo with no setup fee. Cancel anytime.',
    '',
    `Add a card & subscribe: ${billingUrl}`,
  ].join('\n');

  const heading = lastDay ? 'Your trial ends today' : 'Your trial is wrapping up';
  return { subject, html: layout({ heading, bodyHtml }), text };
}

// Escape user-supplied values before interpolating into HTML.
function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

module.exports = { onboardingConfirmation, trialReminder };
