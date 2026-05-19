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

// Inject analytics tags into the landing page HTML at request time so
// GTM_ID / GA_ID / FB_PIXEL_ID env vars take effect without a redeploy.
app.use((req, res, next) => {
  if (req.path !== '/' && req.path !== '/index.html') return next();

  const { gtmId, gaId, fbPixelId } = config.analytics;
  if (!gtmId && !gaId && !fbPixelId) return next();

  const fs = require('fs');
  const indexPath = require('path').join(__dirname, 'public', 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');

  if (gtmId) {
    html = html.replace(
      '<script id="gtm-head-snippet"></script>',
      `<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtmId}');</script>`
    );
    html = html.replace(
      '<noscript id="gtm-body-snippet"></noscript>',
      `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${gtmId}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`
    );
  }

  if (gaId) {
    html = html.replace(
      '<script id="ga-snippet"></script>',
      `<script async src="https://www.googletagmanager.com/gtag/js?id=${gaId}"></script><script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments)}gtag('js',new Date());gtag('config','${gaId}');</script>`
    );
  }

  if (fbPixelId) {
    html = html.replace(
      '<script id="fb-pixel-snippet"></script>',
      `<script>!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${fbPixelId}');fbq('track','PageView');</script><noscript><img height="1" width="1" style="display:none" src="https://www.facebook.com/tr?id=${fbPixelId}&ev=PageView&noscript=1"/></noscript>`
    );
  }

  res.type('text/html').send(html);
});

app.get('/sitemap.xml', (req, res) => {
  const base = 'https://www.socalreceptionist.com';
  const pages = ['/', '/privacy', '/terms', '/cookies', '/accessibility'];
  const urls = pages.map(p =>
    `  <url><loc>${base}${p}</loc><changefreq>${p === '/' ? 'weekly' : 'monthly'}</changefreq><priority>${p === '/' ? '1.0' : '0.5'}</priority></url>`
  ).join('\n');
  res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>`
  );
});

app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
    `User-agent: *\nAllow: /\nDisallow: /health\nDisallow: /sms\nDisallow: /voice\nSitemap: https://www.socalreceptionist.com/sitemap.xml\n`
  );
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
    <a href="/privacy">Privacy Policy</a>
    <a href="/terms">Terms of Use</a>
    <a href="/cookies">Cookie Policy</a>
    <a href="/accessibility">Accessibility</a>
  </nav>
  ${bodyHtml}
  <div class="meta">SoCal Receptionist &nbsp;·&nbsp; Murrieta, CA &nbsp;·&nbsp; <a href="mailto:vaxman14@gmail.com">Contact</a></div>

<style>
  #a11y-btn{position:fixed;bottom:24px;left:24px;z-index:9999;width:48px;height:48px;border-radius:50%;background:#4f46e5;color:#fff;border:none;cursor:pointer;box-shadow:0 4px 12px rgba(0,0,0,.3);font-size:22px;display:flex;align-items:center;justify-content:center;transition:background .2s}
  #a11y-btn:hover{background:#3730a3}
  #a11y-btn:focus-visible{outline:3px solid #f47c20;outline-offset:3px}
  #a11y-panel{position:fixed;bottom:82px;left:24px;z-index:9999;background:#fff;border:2px solid #4f46e5;border-radius:12px;padding:16px;width:220px;box-shadow:0 8px 24px rgba(0,0,0,.15);display:none;flex-direction:column;gap:10px}
  #a11y-panel.open{display:flex}
  #a11y-panel h3{font-size:.85rem;font-weight:700;color:#4f46e5;margin:0 0 4px}
  .a11y-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
  .a11y-label{font-size:.8rem;color:#374151;flex:1}
  .a11y-controls{display:flex;gap:4px}
  .a11y-controls button,#a11y-reset{background:#f3f4f6;border:1px solid #d1d5db;border-radius:6px;cursor:pointer;font-size:.8rem;padding:3px 8px;color:#1a1a2e;transition:background .15s}
  .a11y-controls button:hover,#a11y-reset:hover{background:#e5e7eb}
  .a11y-toggle{position:relative;width:40px;height:22px;flex-shrink:0}
  .a11y-toggle input{opacity:0;width:0;height:0}
  .a11y-toggle .slider{position:absolute;inset:0;background:#d1d5db;border-radius:22px;cursor:pointer;transition:background .2s}
  .a11y-toggle .slider:before{content:'';position:absolute;width:16px;height:16px;left:3px;bottom:3px;background:#fff;border-radius:50%;transition:transform .2s}
  .a11y-toggle input:checked+.slider{background:#4f46e5}
  .a11y-toggle input:checked+.slider:before{transform:translateX(18px)}
  #a11y-reset{width:100%;margin-top:4px}
  body.a11y-high-contrast{filter:contrast(1.5) saturate(0)}
  body.a11y-reduce-motion *,body.a11y-reduce-motion *::before,body.a11y-reduce-motion *::after{animation-duration:.01ms!important;transition-duration:.01ms!important}
  body.a11y-dyslexia{font-family:Arial,Helvetica,sans-serif!important;letter-spacing:.05em;word-spacing:.1em;line-height:1.9!important}
</style>
<button id="a11y-btn" aria-label="Accessibility options" aria-expanded="false" aria-controls="a11y-panel">♿</button>
<div id="a11y-panel" role="dialog" aria-label="Accessibility options" aria-modal="false">
  <h3>Accessibility</h3>
  <div class="a11y-row"><span class="a11y-label">Text size</span><div class="a11y-controls"><button id="a11y-dec" aria-label="Decrease text size">A−</button><button id="a11y-inc" aria-label="Increase text size">A+</button></div></div>
  <div class="a11y-row"><label class="a11y-label" for="a11y-contrast">High contrast</label><label class="a11y-toggle"><input type="checkbox" id="a11y-contrast"/><span class="slider"></span></label></div>
  <div class="a11y-row"><label class="a11y-label" for="a11y-motion">Reduce motion</label><label class="a11y-toggle"><input type="checkbox" id="a11y-motion"/><span class="slider"></span></label></div>
  <div class="a11y-row"><label class="a11y-label" for="a11y-dyslexia">Dyslexia-friendly</label><label class="a11y-toggle"><input type="checkbox" id="a11y-dyslexia"/><span class="slider"></span></label></div>
  <button id="a11y-reset">Reset all</button>
</div>
<script>
(function(){var btn=document.getElementById('a11y-btn'),panel=document.getElementById('a11y-panel'),body=document.body,KEY='a11y_prefs',fs=100;
function applyFs(){body.style.fontSize=fs===100?'':fs+'%'}
function save(){localStorage.setItem(KEY,JSON.stringify({fontSize:fs,contrast:document.getElementById('a11y-contrast').checked,motion:document.getElementById('a11y-motion').checked,dyslexia:document.getElementById('a11y-dyslexia').checked}))}
function load(){try{var p=JSON.parse(localStorage.getItem(KEY)||'{}');if(p.fontSize){fs=p.fontSize;applyFs()}if(p.contrast){document.getElementById('a11y-contrast').checked=true;body.classList.add('a11y-high-contrast')}if(p.motion){document.getElementById('a11y-motion').checked=true;body.classList.add('a11y-reduce-motion')}if(p.dyslexia){document.getElementById('a11y-dyslexia').checked=true;body.classList.add('a11y-dyslexia')}}catch(e){}}
btn.addEventListener('click',function(){var o=panel.classList.toggle('open');btn.setAttribute('aria-expanded',o)});
document.addEventListener('click',function(e){if(!panel.contains(e.target)&&e.target!==btn){panel.classList.remove('open');btn.setAttribute('aria-expanded','false')}});
document.addEventListener('keydown',function(e){if(e.key==='Escape'){panel.classList.remove('open');btn.setAttribute('aria-expanded','false');btn.focus()}});
document.getElementById('a11y-inc').addEventListener('click',function(){fs=Math.min(fs+10,150);applyFs();save()});
document.getElementById('a11y-dec').addEventListener('click',function(){fs=Math.max(fs-10,80);applyFs();save()});
['contrast','motion','dyslexia'].forEach(function(id){document.getElementById('a11y-'+id).addEventListener('change',function(){body.classList.toggle('a11y-'+(id==='contrast'?'high-contrast':id==='motion'?'reduce-motion':'dyslexia'),this.checked);save()})});
document.getElementById('a11y-reset').addEventListener('click',function(){fs=100;applyFs();['contrast','motion','dyslexia'].forEach(function(id){document.getElementById('a11y-'+id).checked=false});body.classList.remove('a11y-high-contrast','a11y-reduce-motion','a11y-dyslexia');localStorage.removeItem(KEY)});
load()})();
</script>
</body>
</html>`;
}

app.get('/privacy', (req, res) => {
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
  <p>Questions? Email us at <a href="mailto:vaxman14@gmail.com">vaxman14@gmail.com</a>.</p>
  `));
});

app.get('/terms', (req, res) => {
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
  <p>Questions? Email us at <a href="mailto:vaxman14@gmail.com">vaxman14@gmail.com</a>.</p>
  `));
});

app.get('/cookies', (req, res) => {
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
    <li>Third-party analytics cookies (e.g., Google Analytics)</li>
    <li>Social media cookies</li>
    <li>Cookies that collect personal information for marketing purposes</li>
  </ul>

  <h2>SMS Service</h2>
  <p>Our primary service is delivered via SMS and does not use cookies. The cookie policy above applies to website visits only.</p>

  <h2>Managing Cookies</h2>
  <p>You can control cookies through your browser settings. Most browsers allow you to refuse or delete cookies. Note that disabling essential cookies may affect website functionality. For instructions, visit your browser's help documentation.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this policy periodically. Check this page for the latest version.</p>

  <h2>Contact</h2>
  <p>Questions? Email us at <a href="mailto:vaxman14@gmail.com">vaxman14@gmail.com</a>.</p>
  `));
});

app.get('/accessibility', (req, res) => {
  res.type('text/html').send(legalPage('Accessibility Statement', `
  <h1>Accessibility Statement</h1>
  <p>Last updated: May 2026</p>
  <p><strong>SoCal Receptionist</strong> is committed to ensuring digital accessibility for people with disabilities. We continually improve the user experience for everyone and apply relevant accessibility standards.</p>

  <h2>Our Commitment</h2>
  <p>We aim to conform to the <strong>Web Content Accessibility Guidelines (WCAG) 2.1, Level AA</strong>. These guidelines explain how to make web content more accessible to people with disabilities.</p>

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
  <p>Our SMS service uses plain text messages, which are compatible with most assistive technologies available on mobile devices, including screen readers and text-to-speech software.</p>

  <h2>Known Limitations</h2>
  <p>While we strive for full accessibility, some areas of the website may not yet fully conform to WCAG 2.1 AA. We are actively working to address any gaps.</p>

  <h2>Feedback &amp; Contact</h2>
  <p>We welcome your feedback on the accessibility of our website and service. If you experience any barriers or have suggestions:</p>
  <ul>
    <li>Email: <a href="mailto:vaxman14@gmail.com">vaxman14@gmail.com</a></li>
  </ul>
  <p>We aim to respond to accessibility feedback within 2 business days.</p>

  <h2>Formal Complaints</h2>
  <p>If you are not satisfied with our response, you may contact the <a href="https://www.ada.gov" target="_blank" rel="noopener">ADA National Network</a> or file a complaint with the U.S. Department of Justice.</p>
  `));
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
