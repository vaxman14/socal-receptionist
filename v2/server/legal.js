const express = require('express');
const router = express.Router();

function legalPage(title, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} — SoCal Receptionist</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:720px;margin:0 auto;padding:40px 24px;color:#1a1a2e;line-height:1.7;background:#fff}
    a{color:#4f46e5}
    h1{font-size:1.6rem;font-weight:700;margin-bottom:.25rem}
    h2{font-size:1.1rem;font-weight:600;margin-top:2.5rem;margin-bottom:.5rem;color:#4f46e5}
    p,li{font-size:.95rem;color:#374151}
    ul{padding-left:1.4rem}
    nav{margin-bottom:2rem;font-size:.85rem}
    nav a{margin-right:1rem;color:#6b7280;text-decoration:none}
    nav a:hover{color:#4f46e5}
    .meta{margin-top:3rem;padding-top:1rem;border-top:1px solid #e5e7eb;font-size:.8rem;color:#9ca3af}
  </style>
</head>
<body>
  <nav>
    <a href="/">← Home</a>
    <a href="/faq">FAQ</a>
    <a href="/support">Support</a>
    <a href="/privacy">Privacy Policy</a>
    <a href="/terms">Terms of Use</a>
    <a href="/sms-terms">SMS Terms</a>
    <a href="/cookies">Cookie Policy</a>
    <a href="/accessibility">Accessibility</a>
  </nav>
  ${bodyHtml}
  <div class="meta">SoCal Receptionist &nbsp;·&nbsp; Murrieta, CA &nbsp;·&nbsp; <a href="mailto:info@socalreceptionist.com">Contact</a></div>
</body>
</html>`;
}

router.get('/privacy', (req, res) => {
  res.type('text/html').send(legalPage('Privacy Policy', `
  <h1>Privacy Policy</h1>
  <p>Last updated: May 2026</p>
  <p><strong>SoCal Receptionist</strong> ("we," "us," or "our") provides an AI-powered virtual receptionist service via SMS to small businesses in Southern California. This Privacy Policy explains how we collect, use, and protect information when you interact with our service.</p>

  <h2>Information We Collect</h2>
  <ul>
    <li><strong>Phone number</strong> — collected when you initiate a text conversation with a business using our service.</li>
    <li><strong>Message content</strong> — the text messages you send are processed to generate a response. We do not retain message transcripts beyond what is necessary to maintain conversation context during an active session.</li>
    <li><strong>Consent status</strong> — we record whether you have opted in or opted out of automated messaging.</li>
  </ul>

  <h2>SMS Opt-In Consent</h2>
  <p>Before you receive any automated messages, you will be prompted to reply <strong>YES</strong>. No marketing or AI messages are sent until you explicitly consent. You may opt out at any time by replying <strong>STOP</strong>.</p>

  <h2>Message Frequency</h2>
  <p>Message frequency varies based on your inquiries. Typically 1–5 messages per conversation.</p>

  <h2>How to Opt Out</h2>
  <p>Reply <strong>STOP</strong> at any time to stop all messages. You will receive one confirmation and no further messages will be sent. Reply <strong>HELP</strong> for assistance.</p>

  <h2>How We Use Your Information</h2>
  <ul>
    <li>To respond to your inquiries and connect you with the business</li>
    <li>To maintain opt-in/opt-out compliance</li>
    <li>To improve service quality</li>
  </ul>
  <p>We do <strong>not</strong> sell, rent, or share your personal information with third parties for marketing purposes.</p>

  <h2>Data Retention</h2>
  <p>Consent status is retained for compliance purposes. Conversation content is held only for the duration of an active session and is not stored permanently.</p>

  <h2>Message &amp; Data Rates</h2>
  <p>Standard message and data rates may apply depending on your mobile carrier plan.</p>

  <h2>Third-Party Services</h2>
  <p>We use Twilio for SMS delivery and OpenAI for AI-generated responses. Both services process message content under their own privacy policies. Twilio: <a href="https://www.twilio.com/legal/privacy" target="_blank" rel="noopener">twilio.com/legal/privacy</a>. OpenAI: <a href="https://openai.com/policies/privacy-policy" target="_blank" rel="noopener">openai.com/policies/privacy-policy</a>.</p>

  <h2>Children's Privacy</h2>
  <p>Our service is not directed to children under 13. We do not knowingly collect information from children.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this policy periodically. Continued use of the service after changes constitutes acceptance of the updated policy.</p>

  <h2>Contact</h2>
  <p>Questions? Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
  `));
});

router.get('/terms', (req, res) => {
  res.type('text/html').send(legalPage('Terms of Use', `
  <h1>Terms of Use</h1>
  <p>Last updated: May 2026</p>
  <p>By using the SMS service provided by <strong>SoCal Receptionist</strong>, you agree to these Terms of Use. If you do not agree, do not use the service.</p>

  <h2>The Service</h2>
  <p>SoCal Receptionist provides an AI-powered virtual receptionist delivered via SMS. The service answers general inquiries, provides business information, and facilitates appointment scheduling on behalf of participating businesses.</p>

  <h2>Acceptable Use</h2>
  <p>You agree not to:</p>
  <ul>
    <li>Use the service for any unlawful purpose</li>
    <li>Send abusive, harassing, or threatening messages</li>
    <li>Attempt to manipulate, reverse-engineer, or disrupt the AI system</li>
    <li>Use the service to transmit spam or unsolicited commercial messages</li>
  </ul>

  <h2>AI-Generated Responses</h2>
  <p>Responses are generated by an AI system and may not always be accurate, complete, or up to date. The AI is not a licensed professional in any field. Do not rely solely on AI responses for legal, medical, financial, or safety decisions. Always confirm important details directly with the business.</p>

  <h2>Opt-In Requirement</h2>
  <p>You must reply <strong>YES</strong> to the consent prompt before receiving AI messages. By doing so, you agree to receive automated text messages from the service. Reply <strong>STOP</strong> at any time to opt out.</p>

  <h2>No Warranties</h2>
  <p>The service is provided "as is" without warranty of any kind. We do not guarantee uninterrupted service, accuracy of AI responses, or that the service will meet your specific needs.</p>

  <h2>Limitation of Liability</h2>
  <p>To the fullest extent permitted by applicable law, SoCal Receptionist shall not be liable for any indirect, incidental, or consequential damages arising from your use of the service.</p>

  <h2>Governing Law</h2>
  <p>These terms are governed by the laws of the State of California. Any disputes shall be resolved in the courts of Riverside County, California.</p>

  <h2>Changes to These Terms</h2>
  <p>We may update these terms at any time. Continued use of the service constitutes acceptance of the updated terms.</p>

  <h2>Contact</h2>
  <p>Questions? Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
  `));
});

router.get('/sms-terms', (req, res) => {
  res.type('text/html').send(legalPage('SMS Terms & Conditions', `
  <h1>SMS Terms &amp; Conditions</h1>
  <p>Last updated: May 2026</p>

  <h2>Program Description</h2>
  <p><strong>SoCal Receptionist</strong> provides an AI-powered virtual receptionist service that communicates with callers and customers via SMS on behalf of small businesses in Southern California. Messages may include appointment scheduling, business inquiries, and follow-ups.</p>

  <h2>How to Opt In</h2>
  <p>You opt in to receive SMS messages in one of the following ways:</p>
  <ul>
    <li>By texting a business phone number powered by SoCal Receptionist, you will receive a one-time confirmation request asking you to reply <strong>YES</strong> to consent to automated messages.</li>
    <li>By submitting your phone number on our website contact form, you consent to receive SMS follow-up messages from SoCal Receptionist.</li>
  </ul>
  <p>No automated messages are sent until you explicitly consent.</p>

  <h2>Message Frequency</h2>
  <p>Message frequency varies based on your interactions. Typically 1–5 messages per conversation. You will not receive unsolicited marketing messages.</p>

  <h2>Message &amp; Data Rates</h2>
  <p>Standard message and data rates may apply depending on your mobile carrier plan. SoCal Receptionist does not charge for SMS messages.</p>

  <h2>How to Opt Out</h2>
  <p>Reply <strong>STOP</strong> at any time to immediately stop all SMS messages from the number you received them from. You will receive one final confirmation message and no further messages will be sent.</p>

  <h2>How to Get Help</h2>
  <p>Reply <strong>HELP</strong> for assistance, or contact us directly:</p>
  <ul>
    <li><strong>Email:</strong> <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a></li>
    <li><strong>Website:</strong> <a href="https://www.socalreceptionist.com/support">socalreceptionist.com/support</a></li>
  </ul>

  <h2>Supported Carriers</h2>
  <p>Major US carriers including AT&amp;T, Verizon, T-Mobile, Sprint, and others. Carrier support may vary.</p>

  <h2>Privacy</h2>
  <p>Your phone number and message content are used solely to provide the virtual receptionist service. We do not sell or share your phone number for marketing purposes. See our full <a href="/privacy">Privacy Policy</a>.</p>

  <h2>Changes</h2>
  <p>We may update these terms periodically. Continued use of the SMS service after changes constitutes acceptance of the updated terms.</p>

  <h2>Contact</h2>
  <p>Questions? Email <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
  `));
});

router.get('/cookies', (req, res) => {
  res.type('text/html').send(legalPage('Cookie Policy', `
  <h1>Cookie Policy</h1>
  <p>Last updated: May 2026</p>
  <p>This Cookie Policy explains how <strong>SoCal Receptionist</strong> uses cookies and similar technologies on our website (<a href="https://www.socalreceptionist.com">socalreceptionist.com</a>).</p>

  <h2>What Are Cookies?</h2>
  <p>Cookies are small text files placed on your device when you visit a website. They help the site remember information about your visit, which can make your next visit easier and the site more useful to you.</p>

  <h2>What Cookies We Use</h2>
  <p>Our website uses only <strong>essential cookies</strong> necessary for basic functionality:</p>
  <ul>
    <li><strong>Session cookies</strong> — temporary cookies that expire when you close your browser. Used to maintain your session while navigating the site.</li>
  </ul>
  <p>We do <strong>not</strong> use:</p>
  <ul>
    <li>Advertising or tracking cookies</li>
    <li>Third-party analytics cookies</li>
    <li>Social media cookies</li>
    <li>Cookies that collect personal information for marketing purposes</li>
  </ul>

  <h2>SMS Service</h2>
  <p>Our primary service is delivered via SMS and does not use cookies. The cookie policy above applies to website visits only.</p>

  <h2>Managing Cookies</h2>
  <p>You can control cookies through your browser settings. Most browsers allow you to refuse or delete cookies. Note that disabling essential cookies may affect website functionality.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this policy periodically. Check this page for the latest version.</p>

  <h2>Contact</h2>
  <p>Questions? Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
  `));
});

router.get('/accessibility', (req, res) => {
  res.type('text/html').send(legalPage('Accessibility Statement', `
  <h1>Accessibility Statement</h1>
  <p>Last updated: May 2026</p>
  <p><strong>SoCal Receptionist</strong> is committed to ensuring digital accessibility for people with disabilities. We continually improve the user experience for everyone and apply relevant accessibility standards.</p>

  <h2>Our Commitment</h2>
  <p>We aim to conform to the <strong>Web Content Accessibility Guidelines (WCAG) 2.1, Level AA</strong>.</p>

  <h2>Measures We Take</h2>
  <ul>
    <li>Semantic HTML structure for screen reader compatibility</li>
    <li>Sufficient color contrast ratios throughout the site</li>
    <li>Descriptive link text and button labels</li>
    <li>Keyboard-navigable interface</li>
    <li>Responsive design that works across device sizes</li>
    <li>Alt text on meaningful images</li>
  </ul>

  <h2>SMS Accessibility</h2>
  <p>Our SMS service uses plain text messages, which are compatible with most assistive technologies available on mobile devices.</p>

  <h2>Feedback &amp; Contact</h2>
  <ul>
    <li>Email: <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a></li>
  </ul>
  <p>We aim to respond to accessibility feedback within 2 business days.</p>
  `));
});

router.get('/faq', (req, res) => {
  res.type('text/html').send(legalPage('FAQ', `
  <style>
    details{border:1px solid #e5e7eb;border-radius:8px;margin:.5rem 0;padding:0 1rem;background:#fafafa}
    details[open]{background:#fff;box-shadow:0 1px 4px rgba(0,0,0,.05)}
    summary{cursor:pointer;font-weight:600;font-size:.95rem;padding:.85rem 0;color:#1a1a2e;list-style:none}
    summary::-webkit-details-marker{display:none}
    summary::before{content:'+';color:#4f46e5;font-weight:700;margin-right:.6rem;display:inline-block;width:1rem}
    details[open] summary::before{content:'\\2212'}
    details > p, details > ul{margin-top:0;padding-bottom:.85rem}
  </style>
  <h1>Frequently Asked Questions</h1>

  <h2>For Customers</h2>
  <details><summary>What is SoCal Receptionist?</summary>
  <p>SoCal Receptionist is an AI-powered virtual receptionist that participating Southern California businesses use to answer text messages. When you text a business that uses our service, our AI helps answer your questions, share business information, and schedule appointments — usually within seconds, day or night.</p></details>

  <details><summary>Am I talking to a real person?</summary>
  <p>No — responses are generated by an AI assistant on behalf of the business. For legal, medical, financial, or safety matters, always confirm details with the business itself.</p></details>

  <details><summary>How do I stop receiving messages?</summary>
  <p>Reply <strong>STOP</strong> at any time. You'll get one confirmation message and then no further automated messages.</p></details>

  <details><summary>Will I be charged to text?</summary>
  <p>SoCal Receptionist does not charge you anything. Standard message and data rates from your mobile carrier may apply.</p></details>

  <h2>For Businesses</h2>
  <details><summary>What does it cost?</summary>
  <p>Pricing is a one-time setup fee plus a flat monthly rate. Contact us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> for a quote.</p></details>

  <details><summary>Is customer data kept secure?</summary>
  <p>Yes. We collect only what's needed to run the service, never sell personal information, and retain conversation content only as long as needed to maintain context. See our <a href="/privacy">Privacy Policy</a>.</p></details>

  <h2>Still have questions?</h2>
  <p>Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> or visit our <a href="/support">Support page</a>.</p>
  `));
});

router.get('/support', (req, res) => {
  res.type('text/html').send(legalPage('Support', `
  <h1>Support</h1>
  <p>Need help with SoCal Receptionist? We're here for both customers and business owners.</p>

  <h2>Contact Us</h2>
  <ul>
    <li><strong>Email:</strong> <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a></li>
    <li><strong>Location:</strong> Murrieta, CA</li>
  </ul>
  <p>We aim to respond to all support requests within <strong>1 business day</strong>.</p>

  <h2>Text-Message Keywords</h2>
  <ul>
    <li><strong>STOP</strong> — opt out of all automated messages.</li>
    <li><strong>HELP</strong> — get assistance and our contact information.</li>
    <li><strong>YES</strong> — opt in to automated messaging after the consent prompt.</li>
  </ul>

  <h2>More Answers</h2>
  <p>Many common questions are answered on our <a href="/faq">FAQ page</a>.</p>
  `));
});

router.post('/delete-account', express.urlencoded({ extended: false }), express.json(), async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !email.includes('@')) {
    return res.type('text/html').send(legalPage('Delete Account', `
    <h1>Delete Account &amp; Data</h1>
    <p style="color:#dc2626;font-weight:600">Please enter a valid email address.</p>
    <form method="POST" action="/delete-account" style="margin-top:1.5rem;display:flex;flex-direction:column;gap:1rem;max-width:400px">
      <label style="font-size:.9rem;font-weight:600">Email address on your account</label>
      <input type="email" name="email" required placeholder="you@example.com" style="padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:.95rem">
      <button type="submit" style="padding:12px;background:#dc2626;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer">Request Deletion</button>
    </form>
    `));
  }

  try {
    const nodemailer = require('nodemailer');
    const transport = nodemailer.createTransport({
      host: process.env.SMTP_HOST || 'smtp.gmail.com',
      port: 587,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
    await transport.sendMail({
      from: `"SoCal Receptionist" <${process.env.SMTP_USER || 'info@socalreceptionist.com'}>`,
      to: 'info@socalreceptionist.com',
      subject: `[DATA DELETION REQUEST] ${email}`,
      text: `A user has requested deletion of their account and all associated data.\n\nEmail: ${email}\nSubmitted: ${new Date().toISOString()}\n\nAction required: delete Supabase auth user, tenant record, and all associated rows within 30 days.`,
    });
  } catch (_) {
    // email failure is non-fatal — request is logged in server output
    console.warn(`[delete-account] email notification failed for ${email}`);
  }

  console.log(`[delete-account] deletion requested for ${email}`);
  return res.type('text/html').send(legalPage('Delete Account', `
  <h1>Deletion Request Received</h1>
  <p>We've received your request to delete the account associated with <strong>${email.replace(/</g, '&lt;')}</strong> and all related data.</p>
  <p>We will process your request within <strong>30 days</strong> and send a confirmation to that email address when complete.</p>
  <p>If you have questions, contact <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
  `));
});

router.get('/delete-account', (req, res) => {
  res.type('text/html').send(legalPage('Delete Account', `
  <h1>Delete Account &amp; Data</h1>
  <p>If you would like to delete your SoCal Receptionist account and all associated data, submit your email address below. We will process your request within <strong>30 days</strong>.</p>
  <p>Data deleted includes: your account credentials, business profile, conversation history, and all stored personal information. SMS opt-out records may be retained for legal compliance.</p>
  <form method="POST" action="/delete-account" style="margin-top:1.5rem;display:flex;flex-direction:column;gap:1rem;max-width:400px">
    <label style="font-size:.9rem;font-weight:600">Email address on your account</label>
    <input type="email" name="email" required placeholder="you@example.com" style="padding:10px 14px;border:1px solid #d1d5db;border-radius:8px;font-size:.95rem">
    <button type="submit" style="padding:12px;background:#dc2626;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer">Request Deletion</button>
  </form>
  <p style="margin-top:1.5rem;font-size:.85rem;color:#6b7280">Alternatively, email <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> with the subject line "Delete My Account".</p>
  `));
});

module.exports = router;
