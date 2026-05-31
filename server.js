const express = require('express');
const path = require('path');
const twilio = require('twilio');
const config = require('./src/config');
const { handleMessage } = require('./src/ai');
const { isValidTwilioRequest } = require('./src/twilio');
const consent = require('./src/consent');
const { notifyDemoRequest, notifyOptIn, notifyEarlyAccess } = require('./src/email');
const { handleRealtimeCall } = require('./src/voice-realtime');
const { initiateCall, handleOutboundStream } = require('./src/voice-outbound');
const { makeStreamToken } = require('./src/stream-auth');
const emailPoller = require('./src/email-poller');
const crypto = require('crypto');

const app = express();
require('express-ws')(app);

// Trust only the first proxy (DigitalOcean LB). `true` would trust any forged X-Forwarded-For.
app.set('trust proxy', 1);

// Redirect naked domain → www
app.use((req, res, next) => {
  if (req.hostname === 'socalreceptionist.com') {
    return res.redirect(301, `https://www.socalreceptionist.com${req.originalUrl}`);
  }
  next();
});
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// --- Rate limiting (in-memory, sliding window, per-IP) ---
const _rlStore = new Map();
setInterval(() => {
  const cutoff = Date.now() - 3_600_000;
  for (const [k, hits] of _rlStore) if (!hits.length || hits[hits.length - 1] < cutoff) _rlStore.delete(k);
}, 300_000).unref();
function rateLimit(maxHits, windowMs) {
  return (req, res, next) => {
    const key = `${req.path}:${req.ip}`;
    const now = Date.now();
    const hits = (_rlStore.get(key) || []).filter(t => t > now - windowMs);
    if (hits.length >= maxHits) return res.status(429).type('text/plain').send('Too many requests. Try again later.');
    hits.push(now);
    _rlStore.set(key, hits);
    next();
  };
}


app.get('/health', (req, res) => {
  res.json({ status: 'ok', business: config.business.name });
});

// Temporary Google OAuth callback — captures refresh tokens for multiple accounts
app.get('/auth/google-callback', async (req, res) => {
  const code = req.query.code;
  const state = req.query.state || 'unknown';
  if (!code) return res.send('No code in request.');
  try {
    const { google } = require('googleapis');
    const oauth2 = new google.auth.OAuth2(
      config.gcal.clientId,
      config.gcal.clientSecret,
      'https://www.socalreceptionist.com/auth/google-callback'
    );
    const { tokens } = await oauth2.getToken(code);
    console.log(`[google-auth] ACCOUNT=${state} REFRESH_TOKEN=${tokens.refresh_token}`);
    res.send(`<h2>Authorized ${state}! ✅</h2><p>Josi has the token. Close this tab and authorize the next account.</p>`);
  } catch (err) {
    res.send('Error: ' + err.message);
  }
});

// Coming Soon mode — must be before static middleware so it intercepts /
if (process.env.COMING_SOON === 'true') {
  app.get('*', (req, res, next) => {
    if (req.path === '/health' || req.path.startsWith('/sms') || req.path.startsWith('/voice')) return next();
    if (req.path.startsWith('/images/') || req.path.startsWith('/favicon')) return next();
    if (req.query.preview === 'socal2026') return next();
    res.type('text/html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SoCal Receptionist — Coming Soon</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1f3d;color:#fff;min-height:100vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px}
    .logo{font-size:1.6rem;font-weight:800;margin-bottom:28px;background:linear-gradient(90deg,#f47c20,#e040a0,#9c40e0);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;letter-spacing:-0.5px}
    .logo span{-webkit-text-fill-color:rgba(255,255,255,0.85);font-size:0.55em;font-weight:600;letter-spacing:2px;text-transform:uppercase;display:block;margin-top:2px}
    h1{font-size:clamp(1.9rem,4.5vw,3rem);font-weight:800;margin-bottom:14px;line-height:1.15}
    .sub{font-size:1.05rem;color:rgba(255,255,255,0.72);max-width:460px;line-height:1.55;margin:0 auto 28px}
    .call-card{max-width:380px;margin:0 auto 24px;padding:22px 22px 20px;border-radius:14px;background:linear-gradient(135deg,rgba(244,124,32,.18),rgba(224,64,160,.14),rgba(156,64,224,.18));border:1px solid rgba(244,124,32,.35)}
    .call-card .label{font-size:.72rem;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:#f47c20;margin-bottom:8px}
    .call-card .tagline{font-size:1.05rem;font-weight:600;color:#fff;margin-bottom:14px;line-height:1.35}
    .call-card .number{display:block;font-size:1.65rem;font-weight:800;color:#fff;text-decoration:none;letter-spacing:-.5px;padding:14px 18px;background:#f47c20;border-radius:10px;transition:background .15s,transform .1s}
    .call-card .number:hover{background:#d96a10}
    .call-card .number:active{transform:translateY(1px)}
    .call-card .footnote{font-size:.78rem;color:rgba(255,255,255,.55);margin-top:10px}
    .divider{display:flex;align-items:center;max-width:340px;margin:14px auto 14px;color:rgba(255,255,255,.4);font-size:.75rem;text-transform:uppercase;letter-spacing:2px}
    .divider::before,.divider::after{content:"";flex:1;height:1px;background:rgba(255,255,255,.15)}
    .divider span{padding:0 12px}
    details{max-width:340px;margin:0 auto;text-align:left}
    summary{cursor:pointer;text-align:center;color:rgba(255,255,255,.75);font-size:.9rem;padding:8px;list-style:none;outline:none}
    summary::-webkit-details-marker{display:none}
    summary:hover{color:#fff}
    details[open] summary{margin-bottom:10px}
    form{display:flex;flex-direction:column;gap:10px}
    input{width:100%;padding:13px 16px;border-radius:8px;border:1px solid rgba(255,255,255,0.18);background:rgba(255,255,255,0.06);color:#fff;font-size:1rem;font-family:inherit}
    input::placeholder{color:rgba(255,255,255,0.45)}
    input:focus{outline:none;border-color:#e040a0;background:rgba(255,255,255,0.1)}
    button{width:100%;margin-top:4px;background:transparent;color:#fff;padding:13px 24px;border:1px solid rgba(255,255,255,0.4);border-radius:8px;font-weight:600;font-size:.95rem;font-family:inherit;cursor:pointer;transition:background .15s,border-color .15s}
    button:hover{background:rgba(255,255,255,.08);border-color:rgba(255,255,255,.7)}
    button:disabled{opacity:0.5;cursor:default}
    .msg{font-size:0.9rem;max-width:340px;margin:14px auto 0;min-height:1.2em}
    .msg.ok{color:#4ade80}
    .msg.err{color:#f87171}
  </style>
</head>
<body>
  <div>
    <div class="logo">SoCal<span>Receptionist</span></div>
    <h1>Don't read about it.<br>Call the AI yourself.</h1>
    <p class="sub">Tap the number. Our AI receptionist will answer, pitch you on what it does, and book your demo — exactly like it would for your business 24/7.</p>
    <div class="call-card">
      <div class="label">Test me now</div>
      <div class="tagline">Talk to the AI that would answer your calls.</div>
      <a class="number" href="tel:+19513958776" id="cta-call">(951) 395-8776</a>
      <div class="footnote">2-minute call. Roman follows up within 24 hours.</div>
    </div>
    <div class="divider"><span>or</span></div>
    <details>
      <summary>Prefer to leave info instead? &nbsp;↓</summary>
      <form id="ea-form">
        <input type="text" name="name" placeholder="Your name" required>
        <input type="text" name="business" placeholder="Business name">
        <input type="email" name="email" placeholder="Email address" required>
        <input type="tel" name="phone" placeholder="Phone (optional)">
        <button type="submit">Get Early Access</button>
      </form>
      <p id="ea-msg" class="msg"></p>
    </details>
  </div>
  <script>
    var f=document.getElementById('ea-form'),m=document.getElementById('ea-msg');
    f.addEventListener('submit',function(e){
      e.preventDefault();
      var b=f.querySelector('button');
      var data={name:f.elements['name'].value.trim(),business:f.elements['business'].value.trim(),email:f.elements['email'].value.trim(),phone:f.elements['phone'].value.trim()};
      if(!data.name||!data.email){m.className='msg err';m.textContent='Please enter your name and email.';return;}
      b.disabled=true;b.textContent='Sending...';m.className='msg';m.textContent='';
      fetch('/early-access',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)})
        .then(function(r){return r.json();})
        .then(function(j){
          if(j&&j.ok){f.style.display='none';m.className='msg ok';m.textContent='Thanks — you are on the list. We will reach out the moment we launch.';}
          else{throw new Error('fail');}
        })
        .catch(function(){b.disabled=false;b.textContent='Get Early Access';m.className='msg err';m.textContent='Something went wrong. Try again or email info@socalreceptionist.com.';});
    });
  </script>
</body>
</html>`);
  });
}

app.use(express.static(path.join(__dirname, 'public')));

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
  const pages = ['/', '/faq', '/support', '/privacy', '/terms', '/sms-terms', '/cookies', '/accessibility'];
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
app.post('/demo', rateLimit(5, 15 * 60_000), async (req, res) => {
  const { name, business, phone, type } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Missing required fields' });

  const body =
    `New demo request from the SoCal Receptionist landing page.\n\n` +
    `Name:     ${name}\n` +
    `Business: ${business || '-'}\n` +
    `Phone:    ${phone}\n` +
    `Industry: ${type || '-'}`;

  try {
    await notifyDemoRequest({ name, business, phone, type });
    res.json({ ok: true });
  } catch (err) {
    console.error('Demo notification email failed:', err.message);
    res.status(500).json({ error: 'Email failed' });
  }
});

// Coming-soon page early-access capture form
app.post('/early-access', rateLimit(5, 15 * 60_000), async (req, res) => {
  const { name, business, email, phone } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Missing required fields' });

  try {
    await notifyEarlyAccess({ name, business, email, phone });
    res.json({ ok: true });
  } catch (err) {
    console.error('Early-access notification email failed:', err.message);
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
  <p>Questions? Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
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
  <p>Questions? Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
  `));
});

app.get('/sms-terms', (req, res) => {
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
  <p>Questions? Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>.</p>
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
    <li>Email: <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a></li>
  </ul>
  <p>We aim to respond to accessibility feedback within 2 business days.</p>

  <h2>Formal Complaints</h2>
  <p>If you are not satisfied with our response, you may contact the <a href="https://www.ada.gov" target="_blank" rel="noopener">ADA National Network</a> or file a complaint with the U.S. Department of Justice.</p>
  `));
});

app.get('/faq', (req, res) => {
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
  <p>Last updated: May 2026</p>

  <h2>For Customers</h2>

  <details><summary>What is SoCal Receptionist?</summary>
  <p>SoCal Receptionist is an AI-powered virtual receptionist that participating Southern California businesses use to answer text messages. When you text a business that uses our service, our AI helps answer your questions, share business information, and schedule appointments — usually within seconds, day or night.</p></details>

  <details><summary>Am I talking to a real person?</summary>
  <p>No — responses are generated by an AI assistant on behalf of the business. The AI handles general inquiries, but anything it can't resolve is passed along to the business directly. For legal, medical, financial, or safety matters, always confirm details with the business itself.</p></details>

  <details><summary>How do I stop receiving messages?</summary>
  <p>Reply <strong>STOP</strong> at any time. You'll get one confirmation message and then no further automated messages. You can opt back in later by texting the business again and replying <strong>YES</strong> to the consent prompt.</p></details>

  <details><summary>Will I be charged to text?</summary>
  <p>SoCal Receptionist does not charge you anything. Standard message and data rates from your mobile carrier may apply, depending on your plan. Message frequency is typically 1–5 messages per conversation.</p></details>

  <details><summary>How do I get help?</summary>
  <p>Reply <strong>HELP</strong> to any message for assistance, or email <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a>. See our <a href="/support">Support page</a> for more.</p></details>

  <h2>For Businesses</h2>

  <details><summary>What does the service do for my business?</summary>
  <p>It answers customer texts instantly, 24/7 — fielding common questions, sharing hours and pricing, and helping book appointments — so you stop losing leads to missed messages and after-hours inquiries.</p></details>

  <details><summary>Can I keep my existing phone number?</summary>
  <p>Yes. You don't have to change the number you already advertise. For voice, you can forward calls from your current carrier to your service line. For texting, we can text-enable your existing number — even a landline — without disrupting your voice service. We'll walk you through the options during onboarding.</p></details>

  <details><summary>How fast can I get set up?</summary>
  <p>The product setup itself is quick. The one regulatory step is carrier registration for business texting (A2P 10DLC), which is required for <em>every</em> SMS provider in the U.S. and typically takes a few business days to clear. We handle that registration for you and can bring voice features online first while it processes.</p></details>

  <details><summary>What does it cost?</summary>
  <p>Pricing is a one-time setup fee plus a flat monthly rate — no per-message surprises. Contact us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> for a current quote tailored to your business.</p></details>

  <details><summary>Does it work for my industry?</summary>
  <p>The AI is configured with your business's specific information — services, hours, pricing, policies, and tone. It works well for service businesses such as salons, clinics, gyms, contractors, auto shops, and professional offices.</p></details>

  <details><summary>Is customer data kept secure?</summary>
  <p>Yes. We collect only what's needed to run the service, never sell personal information, and retain conversation content only as long as needed to maintain context. See our <a href="/privacy">Privacy Policy</a> for details.</p></details>

  <details><summary>Is it texting only, or voice too?</summary>
  <p>SMS is the core of the service today, with voice answering available as part of onboarding. Reach out and we'll tell you what's live for your setup.</p></details>

  <h2>Still have questions?</h2>
  <p>Email us at <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> or visit our <a href="/support">Support page</a>.</p>
  `));
});

app.get('/support', (req, res) => {
  res.type('text/html').send(legalPage('Support', `
  <h1>Support</h1>
  <p>Last updated: May 2026</p>
  <p>Need help with SoCal Receptionist? We're here for both the customers who text our participating businesses and the business owners who use our service.</p>

  <h2>Contact Us</h2>
  <ul>
    <li><strong>Email:</strong> <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a></li>
    <li><strong>Location:</strong> Murrieta, CA</li>
  </ul>
  <p>We aim to respond to all support requests within <strong>1 business day</strong>.</p>

  <h2>Text-Message Keywords</h2>
  <p>While texting a business that uses our service, you can reply with these keywords at any time:</p>
  <ul>
    <li><strong>STOP</strong> — opt out of all automated messages. You'll get one confirmation and nothing further.</li>
    <li><strong>HELP</strong> — get assistance and our contact information.</li>
    <li><strong>YES</strong> — opt in to automated messaging after the consent prompt.</li>
  </ul>

  <h2>Common Questions</h2>

  <h2>I'm not receiving any replies</h2>
  <p>Check that you haven't previously replied STOP to that business — if so, you've been opted out. Text the business again and reply YES to the consent prompt to opt back in. Also confirm you have cell signal and aren't blocking the number. If it still doesn't work, email us.</p>

  <h2>I replied STOP by mistake</h2>
  <p>No problem. Simply text the business again — you'll receive a fresh consent prompt. Reply YES and you're opted back in.</p>

  <h2>I'm getting too many messages</h2>
  <p>Automated messages are sent only in response to your inquiries — typically 1–5 per conversation. If something seems wrong, reply STOP to halt all messages and email us so we can look into it.</p>

  <h2>For Business Owners</h2>
  <ul>
    <li><strong>Updating your business info</strong> — to change hours, pricing, services, or how the AI responds, email us with the updates and we'll apply them.</li>
    <li><strong>Billing questions</strong> — email <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> with "Billing" in the subject line.</li>
    <li><strong>Phone number changes</strong> — whether you're forwarding calls or text-enabling an existing number, contact us and we'll coordinate it with you.</li>
    <li><strong>Service issues</strong> — if the AI is responding incorrectly or messages aren't going through, email us right away with examples and we'll investigate.</li>
  </ul>

  <h2>Urgent Issues</h2>
  <p>For service-affecting problems, email <a href="mailto:info@socalreceptionist.com">info@socalreceptionist.com</a> with "URGENT" in the subject line and we'll prioritize it.</p>

  <h2>More Answers</h2>
  <p>Many common questions are answered on our <a href="/faq">FAQ page</a>.</p>
  `));
});

// Twilio inbound voice webhook for the "test me now" sales line.
// Generates a one-time token so the WS stream can verify it came from a real Twilio POST.
app.post('/voice/sales', rateLimit(5, 60_000), (req, res) => {
  if (!isValidTwilioRequest(req)) {
    console.warn('Rejected /voice/sales request: invalid Twilio signature');
    return res.status(403).send('Invalid Twilio signature');
  }

  const host = req.headers.host;
  const rawFrom = req.body.From || '';
  const callSid = req.body.CallSid || '';

  const token = makeStreamToken(callSid, rawFrom);
  const safeFrom = rawFrom.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  // Auth passed as a Parameter (not URL query) — DO strips query params from WS upgrades
  res.type('text/xml');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/voice/sales/stream"><Parameter name="from" value="${safeFrom}"/><Parameter name="auth" value="${token}"/></Stream></Connect></Response>`
  );
});

// WebSocket endpoint — auth token arrives in the Twilio 'start' event (customParameters.auth),
// not in the URL (DO strips WS query params). voice-realtime.js verifies it before connecting OpenAI.
app.ws('/voice/sales/stream', (ws) => {
  handleRealtimeCall(ws);
});

// Twilio status callback — fires when the call ends. We use this to send a
// "partial" lead notification if the caller hung up before we captured them.
app.post('/voice/sales/status', async (req, res) => {
  if (!isValidTwilioRequest(req)) {
    console.warn('Rejected /voice/sales/status request: invalid Twilio signature');
    return res.status(403).send('Invalid Twilio signature');
  }
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const status = req.body.CallStatus;
  const duration = parseInt(req.body.CallDuration || '0', 10);

  // Realtime module handles partial leads on WebSocket close — nothing to do here.
  res.sendStatus(204);
});

// ── Outbound calling ────────────────────────────────────────────────────────
//
// POST /voice/outbound/call   — initiates an outbound call (internal API)
// POST /voice/outbound/start  — Twilio calls this when the prospect answers
// WS   /voice/outbound/stream — Realtime API bridge; AI greets first
//
// Authentication for /voice/outbound/call: simple bearer token via
// OUTBOUND_API_KEY env var. If unset, the endpoint is disabled.

app.post('/voice/outbound/call', express.json(), async (req, res) => {
  const apiKey = process.env.OUTBOUND_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'Outbound calling not configured' });

  const authHeader = req.headers.authorization || '';
  if (authHeader !== `Bearer ${apiKey}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { to, name, businessType, reason } = req.body || {};
  if (!to) return res.status(400).json({ error: 'Missing required field: to' });

  // Basic E.164 sanity check
  if (!/^\+?[1-9]\d{6,14}$/.test(to.replace(/[\s\-().]/g, ''))) {
    return res.status(400).json({ error: 'Invalid phone number format' });
  }

  try {
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const callSid = await initiateCall(to, { name, businessType, reason }, baseUrl);
    res.json({ success: true, callSid });
  } catch (err) {
    console.error('[voice/outbound/call] error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/voice/outbound/start', (req, res) => {
  if (!isValidTwilioRequest(req)) {
    console.warn('Rejected /voice/outbound/start request: invalid Twilio signature');
    return res.status(403).send('Invalid Twilio signature');
  }

  const host = req.headers.host;
  const callSid = req.body.CallSid || '';
  const to = req.body.To || '';

  const token = makeStreamToken(callSid, to);
  const safeTo = to.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

  res.type('text/xml');
  res.send(
    `<?xml version="1.0" encoding="UTF-8"?><Response><Connect><Stream url="wss://${host}/voice/outbound/stream"><Parameter name="to" value="${safeTo}"/><Parameter name="auth" value="${token}"/></Stream></Connect></Response>`
  );
});

app.ws('/voice/outbound/stream', (ws) => {
  handleOutboundStream(ws);
});

app.post('/voice/outbound/status', (req, res) => {
  if (!isValidTwilioRequest(req)) return res.status(403).send('Invalid Twilio signature');
  // Status logged in voice-outbound cleanup; nothing to do here
  res.sendStatus(204);
});

// ── Inbound SMS ─────────────────────────────────────────────────────────────

// Twilio inbound SMS webhook. Twilio POSTs the message here and expects a
// TwiML response, which it delivers back to the customer as the outbound SMS.
app.post('/sms', rateLimit(30, 60_000), async (req, res) => {
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

  const status = await consent.getStatus(from);
  const normalizedBody = body.toUpperCase();

  // Always honor STOP regardless of consent state (Twilio also handles this
  // automatically for toll-free numbers, but we track it ourselves too).
  if (normalizedBody === 'STOP' || normalizedBody === 'UNSUBSCRIBE') {
    await consent.setStatus(from, 'opted_out');
    res.type('text/xml');
    return res.send(twiml.toString()); // send empty TwiML; Twilio sends its own STOP reply
  }

  if (status === 'opted_out') {
    res.type('text/xml');
    return res.send(twiml.toString()); // silently drop — they opted out
  }

  if (status === 'unknown') {
    await consent.setStatus(from, 'pending');
    twiml.message(
      `Hi! You've reached ${config.business.name}. Reply YES to receive automated messages from our virtual receptionist, or STOP to opt out. Msg & data rates may apply.`
    );
    res.type('text/xml');
    return res.send(twiml.toString());
  }

  if (status === 'pending') {
    if (normalizedBody === 'YES' || normalizedBody === 'Y') {
      await consent.setStatus(from, 'opted_in');
      twiml.message(`You're all set! How can I help you today?`);
      notifyOptIn(from).catch(err => console.error('Opt-in notification failed:', err.message));
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
  emailPoller.start();
});
