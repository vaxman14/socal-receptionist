/* SoCal Receptionist — embeddable callback widget (client side).
 *
 * Served as text by GET /widget/v1.js. A law firm drops ONE line on any page:
 *   <script src="https://<backend>/widget/v1.js" data-key="TENANT_KEY" async></script>
 *
 * It renders a floating bubble; the visitor leaves their name + number and the
 * firm gets the lead. (Component 2 will make the AI call them back automatically.)
 *
 * Optional data-* attributes on the script tag:
 *   data-key      (required) the firm's embed key
 *   data-accent   button/accent color (default #f5821f)
 *   data-title    panel heading (default "Request a callback")
 *   data-button   bubble label (default "Call me back")
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (/\/widget\/v1\.js(\?|$)/.test(all[i].src)) { script = all[i]; break; }
    }
  }
  if (!script) return;

  var key = script.getAttribute('data-key');
  if (!key) { console.error('[SoCalWidget] missing data-key'); return; }

  var accent = script.getAttribute('data-accent') || '#f5821f';
  var navy = '#102a43';
  var title = script.getAttribute('data-title') || 'Request a callback';
  var buttonLabel = script.getAttribute('data-button') || 'Call me back';
  var termsUrl = script.getAttribute('data-terms-url') || 'https://www.socalreceptionist.com/terms';
  var privacyUrl = script.getAttribute('data-privacy-url') || 'https://www.socalreceptionist.com/privacy';

  // API base = origin the script was loaded from.
  var apiBase;
  try { apiBase = new URL(script.src).origin; } catch (e) { apiBase = ''; }

  if (window.__socalWidgetLoaded) return;
  window.__socalWidgetLoaded = true;

  var NS = 'socalw';
  var css =
    '.' + NS + '-bubble{position:fixed;bottom:20px;right:20px;z-index:2147483000;background:' + accent + ';color:#fff;border:none;border-radius:999px;padding:14px 20px;font:600 15px/1.2 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.25);cursor:pointer;display:flex;align-items:center;gap:8px}' +
    '.' + NS + '-bubble:hover{filter:brightness(1.05)}' +
    '.' + NS + '-panel{position:fixed;bottom:84px;right:20px;z-index:2147483000;width:320px;max-width:calc(100vw - 40px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;display:none}' +
    '.' + NS + '-panel.open{display:block}' +
    '.' + NS + '-head{background:' + navy + ';color:#fff;padding:16px 18px;font-size:16px;font-weight:700}' +
    '.' + NS + '-head small{display:block;font-weight:400;opacity:.8;font-size:12px;margin-top:3px}' +
    '.' + NS + '-body{padding:16px 18px}' +
    '.' + NS + '-body label{display:block;font-size:12px;font-weight:600;color:#334155;margin:10px 0 4px}' +
    '.' + NS + '-body input{width:100%;box-sizing:border-box;padding:10px 12px;border:1px solid #cbd5e1;border-radius:9px;font-size:14px}' +
    '.' + NS + '-body input:focus{outline:none;border-color:' + accent + '}' +
    '.' + NS + '-submit{width:100%;margin-top:14px;background:' + accent + ';color:#fff;border:none;border-radius:9px;padding:12px;font-size:15px;font-weight:700;cursor:pointer}' +
    '.' + NS + '-submit:disabled{opacity:.6;cursor:default}' +
    '.' + NS + '-msg{padding:18px;text-align:center;font-size:15px;color:#0f5132}' +
    '.' + NS + '-err{color:#b91c1c;font-size:13px;margin-top:8px;min-height:16px}' +
    '.' + NS + '-consent{display:flex;align-items:flex-start;gap:8px;margin-top:14px;font-size:12px;color:#475569;line-height:1.45}' +
    '.' + NS + '-consent input{width:auto;margin:2px 0 0;flex:0 0 auto}' +
    '.' + NS + '-consent a{color:' + accent + ';text-decoration:underline}' +
    '.' + NS + '-foot{padding:0 18px 14px;font-size:11px;color:#94a3b8;text-align:center}' +
    '.' + NS + '-x{float:right;cursor:pointer;opacity:.7;font-weight:400}';

  var styleEl = document.createElement('style');
  styleEl.textContent = css;
  document.head.appendChild(styleEl);

  var bubble = document.createElement('button');
  bubble.className = NS + '-bubble';
  bubble.setAttribute('aria-label', buttonLabel);
  bubble.innerHTML = '<span aria-hidden="true">📞</span><span>' + esc(buttonLabel) + '</span>';

  var panel = document.createElement('div');
  panel.className = NS + '-panel';
  panel.setAttribute('role', 'dialog');
  panel.innerHTML =
    '<div class="' + NS + '-head"><span class="' + NS + '-x" aria-label="Close">✕</span>' + esc(title) +
    '<small>Leave your number and we’ll call you right back.</small></div>' +
    '<div class="' + NS + '-body">' +
      '<label>Your name</label><input type="text" autocomplete="name" maxlength="80" placeholder="Jane Smith">' +
      '<label>Phone number</label><input type="tel" autocomplete="tel" maxlength="25" placeholder="(951) 555-0123">' +
      '<label>Email</label><input type="email" autocomplete="email" maxlength="120" placeholder="you@email.com">' +
      '<label class="' + NS + '-consent"><input type="checkbox">' +
        '<span>I agree to be contacted by phone about my request, and I accept the ' +
        '<a href="' + esc(termsUrl) + '" target="_blank" rel="noopener">Terms of Service</a> and ' +
        '<a href="' + esc(privacyUrl) + '" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>' +
      '<div class="' + NS + '-err"></div>' +
      '<button class="' + NS + '-submit" type="button">' + esc(buttonLabel) + '</button>' +
    '</div>' +
    '<div class="' + NS + '-foot">Powered by SoCal Receptionist</div>';

  document.body.appendChild(panel);
  document.body.appendChild(bubble);

  var nameEl = panel.querySelector('input[type=text]');
  var phoneEl = panel.querySelector('input[type=tel]');
  var emailEl = panel.querySelector('input[type=email]');
  var consentEl = panel.querySelector('input[type=checkbox]');
  var errEl = panel.querySelector('.' + NS + '-err');
  var submitEl = panel.querySelector('.' + NS + '-submit');

  function toggle(open) {
    if (open === undefined) open = !panel.classList.contains('open');
    panel.classList.toggle('open', open);
    if (open) setTimeout(function () { nameEl.focus(); }, 50);
  }
  bubble.addEventListener('click', function () { toggle(); });
  panel.querySelector('.' + NS + '-x').addEventListener('click', function () { toggle(false); });

  submitEl.addEventListener('click', function () {
    errEl.textContent = '';
    var name = nameEl.value.trim();
    var phone = phoneEl.value.trim();
    var email = emailEl.value.trim();
    if (!phone) { errEl.textContent = 'Please enter a phone number.'; return; }
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { errEl.textContent = 'Please enter a valid email.'; return; }
    if (!consentEl.checked) { errEl.textContent = 'Please agree to the terms to continue.'; return; }
    submitEl.disabled = true;
    submitEl.textContent = 'Sending…';
    fetch(apiBase + '/widget/lead', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, name: name, phone: phone, email: email, consent: true, source_url: location.href })
    }).then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (res) {
        if (!res.ok || !res.j.ok) {
          submitEl.disabled = false;
          submitEl.textContent = buttonLabel;
          errEl.textContent = (res.j && res.j.error) || 'Something went wrong. Please try again.';
          return;
        }
        panel.querySelector('.' + NS + '-body').innerHTML =
          '<div class="' + NS + '-msg">✅ Thanks' + (name ? ', ' + esc(name) : '') + '!<br>We’ll call you right back.</div>';
      })
      .catch(function () {
        submitEl.disabled = false;
        submitEl.textContent = buttonLabel;
        errEl.textContent = 'Network error. Please try again.';
      });
  });

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
