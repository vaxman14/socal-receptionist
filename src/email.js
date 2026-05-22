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

// Plain-text owner notification (backwards-compatible)
async function notifyOwner(subject, text) {
  await send({ subject, text });
}

// Called when a customer texts YES and opts in for the first time
async function notifyOptIn(phone) {
  const subject = `New opt-in: ${phone}`;
  const text = `A new customer just opted in to ${config.business.name}.\n\nPhone: ${phone}\nTime: ${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT\n\nThe AI receptionist is now active for this customer.`;
  const html = htmlWrap('New Customer Opt-In', `
    <p>A new customer just opted in to receive messages from your AI receptionist. 🎉</p>
    <table class="data">
      <tr><td>Phone</td><td>${phone}</td></tr>
      <tr><td>Time</td><td>${new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles' })} PT</td></tr>
      <tr><td>Status</td><td><span class="badge badge-green">Opted In</span></td></tr>
    </table>
    <p>The AI receptionist is now active for this customer and will handle their inquiries automatically.</p>
  `);
  await send({ subject, text, html });
}

// Lead captured by AI: customer name + contact + service collected
async function notifyLead({ name, contact, phone, service, notes, calendlyLink }) {
  const subject = `New lead: ${name || 'Unknown'} — ${service || 'inquiry'}`;
  const text =
    `New lead captured by the ${config.business.name} AI receptionist.\n\n` +
    `Name:     ${name || '-'}\nContact:  ${contact || '-'}\nSMS:      ${phone}\n` +
    `Service:  ${service || '-'}\nNotes:    ${notes || '-'}\n\nCalendly: ${calendlyLink}`;
  const html = htmlWrap('New Lead Captured', `
    <p>Your AI receptionist just captured a qualified lead! 🚀</p>
    <table class="data">
      <tr><td>Name</td><td>${name || '-'}</td></tr>
      <tr><td>Contact</td><td>${contact || '-'}</td></tr>
      <tr><td>SMS Number</td><td>${phone}</td></tr>
      <tr><td>Service</td><td>${service || '-'}</td></tr>
      ${notes ? `<tr><td>Notes</td><td>${notes}</td></tr>` : ''}
      <tr><td>Status</td><td><span class="badge badge-purple">Calendly Link Sent</span></td></tr>
    </table>
    <p>The customer was sent your booking link: <a href="${calendlyLink}">${calendlyLink}</a></p>
  `);
  await send({ subject, text, html });
}

// Human follow-up needed
async function notifyFollowup({ phone, reason, question }) {
  const subject = `Follow-up needed — ${phone}`;
  const text =
    `The AI receptionist for ${config.business.name} needs a human to follow up.\n\n` +
    `Customer: ${phone}\nReason: ${reason || '-'}\nQuestion: ${question || '-'}`;
  const html = htmlWrap('Customer Needs Your Attention', `
    <p>Your AI receptionist flagged a customer that needs a human follow-up.</p>
    <table class="data">
      <tr><td>Phone</td><td>${phone}</td></tr>
      <tr><td>Reason</td><td>${reason || '-'}</td></tr>
      <tr><td>Their question</td><td>${question || '-'}</td></tr>
      <tr><td>Status</td><td><span class="badge badge-orange">Needs Follow-Up</span></td></tr>
    </table>
    <p>Reach out to this customer directly when you get a chance.</p>
  `);
  await send({ subject, text, html });
}

// Demo request from the landing page
async function notifyDemoRequest({ name, business, phone, type }) {
  const subject = `Demo request: ${name} — ${business || phone}`;
  const text =
    `New demo request from the SoCal Receptionist landing page.\n\n` +
    `Name:     ${name}\nBusiness: ${business || '-'}\nPhone:    ${phone}\nIndustry: ${type || '-'}`;
  const html = htmlWrap('New Demo Request', `
    <p>Someone filled out the demo request form on your landing page! 📋</p>
    <table class="data">
      <tr><td>Name</td><td>${name}</td></tr>
      <tr><td>Business</td><td>${business || '-'}</td></tr>
      <tr><td>Phone</td><td>${phone}</td></tr>
      <tr><td>Industry</td><td>${type || '-'}</td></tr>
    </table>
    <p>Follow up with them to schedule their demo. Remember: the demo IS the product — have them text the number!</p>
  `);
  await send({ subject, text, html });
}

// Early-access signup from the coming-soon holding page
async function notifyEarlyAccess({ name, business, email, phone }) {
  const subject = `Early access signup: ${name}${business ? ' — ' + business : ''}`;
  const text =
    `New early-access signup from the SoCal Receptionist coming-soon page.\n\n` +
    `Name:     ${name}\nBusiness: ${business || '-'}\nEmail:    ${email}\nPhone:    ${phone || '-'}`;
  const html = htmlWrap('New Early-Access Signup', `
    <p>Someone signed up for early access on your coming-soon page! 🎯</p>
    <table class="data">
      <tr><td>Name</td><td>${name}</td></tr>
      <tr><td>Business</td><td>${business || '-'}</td></tr>
      <tr><td>Email</td><td>${email}</td></tr>
      <tr><td>Phone</td><td>${phone || '-'}</td></tr>
    </table>
    <p>Add them to your launch list and follow up when you go live.</p>
  `);
  await send({ subject, text, html });
}

module.exports = { notifyOwner, notifyOptIn, notifyLead, notifyFollowup, notifyDemoRequest, notifyEarlyAccess };
