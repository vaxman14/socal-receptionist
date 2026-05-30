const nodemailer = require('nodemailer');
const config = require('./config');

const transporter = nodemailer.createTransport({
  host: config.email.host,
  port: config.email.port,
  secure: config.email.port === 465,
  auth: {
    user: config.email.user,
    pass: config.email.pass,
  },
});

function escapeHtml(s) {
  return String(s == null ? '-' : s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

function htmlWrap(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;padding:0;background:#f4f4f8;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
  .wrapper{max-width:560px;margin:32px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.08)}
  .header{background:linear-gradient(135deg,#FF6B35,#E91E8C,#7B2FBE);padding:24px 32px}
  .header h1{margin:0;color:#fff;font-size:1.1rem;font-weight:600;letter-spacing:-.2px}
  .header p{margin:4px 0 0;color:rgba(255,255,255,.8);font-size:.85rem}
  .body{padding:28px 32px}
  .body p{margin:0 0 12px;color:#374151;font-size:.9rem;line-height:1.6}
  table.data{width:100%;border-collapse:collapse;margin:16px 0}
  table.data td{padding:8px 12px;font-size:.85rem;border-bottom:1px solid #f0f0f5}
  table.data td:first-child{color:#6b7280;width:35%;font-weight:500}
  table.data td:last-child{color:#1a1a2e;font-weight:600}
  .badge{display:inline-block;padding:3px 10px;border-radius:999px;font-size:.75rem;font-weight:700}
  .badge-green{background:#d1fae5;color:#065f46}
  .badge-orange{background:#ffedd5;color:#9a3412}
  .badge-purple{background:#ede9fe;color:#5b21b6}
  .footer{background:#f9f9fc;padding:16px 32px;font-size:.75rem;color:#9ca3af;text-align:center}
  .footer a{color:#7B2FBE;text-decoration:none}
</style>
</head>
<body>
<div class="wrapper">
  <div class="header">
    <h1>SoCal Receptionist</h1>
    <p>${title}</p>
  </div>
  <div class="body">
    ${bodyHtml}
  </div>
  <div class="footer">
    AI Receptionist by <a href="https://www.socalreceptionist.com">SoCal Receptionist</a> &nbsp;·&nbsp; <a href="mailto:vaxman14@gmail.com">Contact</a>
  </div>
</div>
</body>
</html>`;
}

async function send({ subject, text, html }) {
  await transporter.sendMail({
    from: config.email.from,
    to: config.business.ownerEmail,
    subject,
    text,
    html,
  });
}

async function notifyOwner(subject, text) {
  await send({ subject, text });
}

async function notifyOptIn(phone) {
  const p = escapeHtml(phone);
  const subject = `New opt-in: ${phone}`;
  const text = `A new customer just opted in to ${config.business.name}.\n\nPhone: ${phone}\nTime: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT\n\nThe AI receptionist is now active for this customer.`;
  const html = htmlWrap('New Customer Opt-In', `
    <p>A new customer just opted in to receive messages from your AI receptionist. 🎉</p>
    <table class="data">
      <tr><td>Phone</td><td>${p}</td></tr>
      <tr><td>Time</td><td>${escapeHtml(new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }))} PT</td></tr>
      <tr><td>Status</td><td><span class="badge badge-green">Opted In</span></td></tr>
    </table>
    <p>The AI receptionist is now active for this customer and will handle their inquiries automatically.</p>
  `);
  await send({ subject, text, html });
}

async function notifyLead({ name, contact, phone, service, notes, calendlyLink }) {
  const subject = `New lead: ${name || 'Unknown'} — ${service || 'inquiry'}`;
  const text =
    `New lead captured by the ${config.business.name} AI receptionist.\n\n` +
    `Name:     ${name || '-'}\nContact:  ${contact || '-'}\nSMS:      ${phone}\n` +
    `Service:  ${service || '-'}\nNotes:    ${notes || '-'}\n\nCalendly: ${calendlyLink}`;
  const html = htmlWrap('New Lead Captured', `
    <p>Your AI receptionist just captured a qualified lead! 🚀</p>
    <table class="data">
      <tr><td>Name</td><td>${escapeHtml(name)}</td></tr>
      <tr><td>Contact</td><td>${escapeHtml(contact)}</td></tr>
      <tr><td>SMS Number</td><td>${escapeHtml(phone)}</td></tr>
      <tr><td>Service</td><td>${escapeHtml(service)}</td></tr>
      ${notes ? `<tr><td>Notes</td><td>${escapeHtml(notes)}</td></tr>` : ''}
      <tr><td>Status</td><td><span class="badge badge-purple">Calendly Link Sent</span></td></tr>
    </table>
    <p>The customer was sent your booking link: <a href="${escapeHtml(calendlyLink)}">${escapeHtml(calendlyLink)}</a></p>
  `);
  await send({ subject, text, html });
}

async function notifyFollowup({ phone, reason, question }) {
  const subject = `Follow-up needed — ${phone}`;
  const text =
    `The AI receptionist for ${config.business.name} needs a human to follow up.\n\n` +
    `Customer: ${phone}\nReason: ${reason || '-'}\nQuestion: ${question || '-'}`;
  const html = htmlWrap('Customer Needs Your Attention', `
    <p>Your AI receptionist flagged a customer that needs a human follow-up.</p>
    <table class="data">
      <tr><td>Phone</td><td>${escapeHtml(phone)}</td></tr>
      <tr><td>Reason</td><td>${escapeHtml(reason)}</td></tr>
      <tr><td>Their question</td><td>${escapeHtml(question)}</td></tr>
      <tr><td>Status</td><td><span class="badge badge-orange">Needs Follow-Up</span></td></tr>
    </table>
    <p>Reach out to this customer directly when you get a chance.</p>
  `);
  await send({ subject, text, html });
}

async function notifyDemoRequest({ name, business, phone, type }) {
  const subject = `Demo request: ${name} — ${business || phone}`;
  const text =
    `New demo request from the SoCal Receptionist landing page.\n\n` +
    `Name:     ${name}\nBusiness: ${business || '-'}\nPhone:    ${phone}\nIndustry: ${type || '-'}`;
  const html = htmlWrap('New Demo Request', `
    <p>Someone filled out the demo request form on your landing page! 📋</p>
    <table class="data">
      <tr><td>Name</td><td>${escapeHtml(name)}</td></tr>
      <tr><td>Business</td><td>${escapeHtml(business)}</td></tr>
      <tr><td>Phone</td><td>${escapeHtml(phone)}</td></tr>
      <tr><td>Industry</td><td>${escapeHtml(type)}</td></tr>
    </table>
    <p>Follow up with them to schedule their demo. Remember: the demo IS the product — have them text the number!</p>
  `);
  await send({ subject, text, html });
}

async function notifyEarlyAccess({ name, business, email, phone }) {
  const subject = `Early access signup: ${name}${business ? ' — ' + business : ''}`;
  const text =
    `New early-access signup from the SoCal Receptionist coming-soon page.\n\n` +
    `Name:     ${name}\nBusiness: ${business || '-'}\nEmail:    ${email}\nPhone:    ${phone || '-'}`;
  const html = htmlWrap('New Early-Access Signup', `
    <p>Someone signed up for early access on your coming-soon page! 🎯</p>
    <table class="data">
      <tr><td>Name</td><td>${escapeHtml(name)}</td></tr>
      <tr><td>Business</td><td>${escapeHtml(business)}</td></tr>
      <tr><td>Email</td><td>${escapeHtml(email)}</td></tr>
      <tr><td>Phone</td><td>${escapeHtml(phone)}</td></tr>
    </table>
    <p>Add them to your launch list and follow up when you go live.</p>
  `);
  await send({ subject, text, html });
}

async function notifySalesLead({ name, business, contact, pain_point, notes, fromNumber, callSid, partial }) {
  const tag = partial ? '⚠️ Sales call ended (no full capture)' : '🔥 New sales lead — test-me-now call';
  const subject = partial
    ? `Sales call hung up early: ${fromNumber || 'unknown'}`
    : `New sales lead: ${name || 'Unknown'} — ${business || 'business'}`;
  const text =
    `${tag}\n\n` +
    `Name:     ${name || '-'}\n` +
    `Business: ${business || '-'}\n` +
    `Contact:  ${contact || '-'}\n` +
    `Pain:     ${pain_point || '-'}\n` +
    `Notes:    ${notes || '-'}\n` +
    `Called from: ${fromNumber || '-'}\n` +
    `CallSid:  ${callSid || '-'}`;
  const html = htmlWrap(partial ? 'Sales call ended early' : 'New Sales Lead Captured', `
    <p>${partial
      ? 'A prospect called the sales line but hung up before all info was captured. Transcript is in the notes — follow up if it looks worth it.'
      : 'A prospect called the sales line, talked with the AI, and the AI just qualified them. 🚀'}</p>
    <table class="data">
      <tr><td>Name</td><td>${escapeHtml(name)}</td></tr>
      <tr><td>Business</td><td>${escapeHtml(business)}</td></tr>
      <tr><td>Contact</td><td>${escapeHtml(contact)}</td></tr>
      <tr><td>Pain point</td><td>${escapeHtml(pain_point)}</td></tr>
      ${notes ? `<tr><td>Notes</td><td><pre style="margin:0;white-space:pre-wrap;font-family:inherit;font-size:.85rem">${escapeHtml(notes)}</pre></td></tr>` : ''}
      <tr><td>Called from</td><td>${escapeHtml(fromNumber)}</td></tr>
      <tr><td>CallSid</td><td><code>${escapeHtml(callSid)}</code></td></tr>
      <tr><td>Status</td><td><span class="badge ${partial ? 'badge-orange' : 'badge-green'}">${partial ? 'Partial' : 'Qualified'}</span></td></tr>
    </table>
    <p>${partial ? 'Reach out to the caller directly to recover the lead.' : 'Reach out within 24 hours with pricing and a setup walkthrough.'}</p>
  `);
  await send({ subject, text, html });
}

async function sendCalendarInvite({ callerName, callerEmail, startIso, hostEmail, hostName }) {
  const start = new Date(startIso);
  const end = new Date(start.getTime() + 30 * 60 * 1000);

  function icsDate(d) {
    return d.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
  }

  const uid = `socal-demo-${Date.now()}@socalreceptionist.com`;
  const now = icsDate(new Date());
  const label = start.toLocaleString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
    timeZone: 'America/Los_Angeles', timeZoneName: 'short',
  });

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SoCal Receptionist//AI Receptionist//EN',
    'METHOD:REQUEST',
    'BEGIN:VEVENT',
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `DTSTAMP:${now}`,
    `UID:${uid}`,
    'SUMMARY:SoCal Receptionist Demo Call',
    `DESCRIPTION:30-minute demo with ${hostName || 'Roman'} at SoCal Receptionist. He'll walk you through how the AI receptionist works and answer any questions.`,
    `ORGANIZER;CN="SoCal Receptionist":mailto:${config.email.user}`,
    `ATTENDEE;CN="${callerName}";RSVP=TRUE:mailto:${callerEmail}`,
    `ATTENDEE;CN="${hostName || 'Roman'}";RSVP=TRUE:mailto:${hostEmail}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  const subject = `Demo booked: ${label}`;
  const text = `Hi ${callerName},\n\nYour 30-minute demo with Roman at SoCal Receptionist is booked for ${label}.\n\nThe calendar invite is attached — add it to your calendar and you're all set!\n\nSee you then,\nSoCal Receptionist`;

  await transporter.sendMail({
    from: config.email.from,
    to: [callerEmail, hostEmail].filter(Boolean).join(', '),
    subject,
    text,
    attachments: [{
      filename: 'invite.ics',
      content: ics,
      contentType: 'text/calendar; method=REQUEST',
    }],
  });
}

async function notifySupportTranscript(history) {
  if (!history || !history.length) return;
  const rows = history.map(m =>
    `<tr><td style="color:${m.role === 'user' ? '#1a1a2e' : '#4f46e5'};font-weight:600;width:80px;padding:6px 12px;vertical-align:top">${escapeHtml(m.role === 'user' ? 'Visitor' : 'Bot')}</td><td style="padding:6px 12px;color:#374151;font-size:.88rem">${escapeHtml(m.content)}</td></tr>`
  ).join('\n');
  const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' });
  const subject = `Support chat transcript — ${timestamp} PT`;
  const text = history.map(m => `${m.role === 'user' ? 'Visitor' : 'Bot'}: ${m.content}`).join('\n\n');
  const html = htmlWrap('Support Chat Transcript', `
    <p>A visitor completed a support chat on the website.</p>
    <table class="data" style="width:100%">${rows}</table>
    <table class="data"><tr><td>Time</td><td>${escapeHtml(timestamp)} PT</td></tr></table>
  `);
  await transporter.sendMail({
    from: config.email.from,
    to: 'support@socalreceptionist.com',
    subject,
    text,
    html,
  });
}

module.exports = { notifyOwner, notifyOptIn, notifyLead, notifyFollowup, notifyDemoRequest, notifyEarlyAccess, notifySalesLead, sendCalendarInvite, notifySupportTranscript };
