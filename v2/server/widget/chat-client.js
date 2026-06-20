/* SoCal Receptionist — embeddable AI chat widget with live human takeover.
 *
 * One line on any site:
 *   <script src="https://<backend>/widget/chat.js"
 *           data-key="TENANT_ID"
 *           data-name="Your Business"
 *           data-about="What you do, hours, services"
 *           data-accent="#7C3AED" async></script>
 *
 * The visitor chats with the AI. They can tap "Talk to a human" — the firm gets
 * pinged and can take over from their dashboard in real time. If no human picks
 * up within a minute, the AI apologises and captures the visitor's details.
 */
(function () {
  'use strict';
  var script = document.currentScript;
  if (!script) {
    var all = document.getElementsByTagName('script');
    for (var i = all.length - 1; i >= 0; i--) {
      if (/\/widget\/chat\.js(\?|$)/.test(all[i].src)) { script = all[i]; break; }
    }
  }
  if (!script || window.__socalChatLoaded) return;
  window.__socalChatLoaded = true;

  var KEY = script.getAttribute('data-key') || '';
  var NAME = (script.getAttribute('data-name') || '').slice(0, 120);
  var ABOUT = (script.getAttribute('data-about') || '').slice(0, 800);
  var ACCENT = script.getAttribute('data-accent') || '#7C3AED';
  var TITLE = script.getAttribute('data-title') || (NAME ? ('Chat with ' + NAME) : 'Chat with us');
  var apiBase;
  try { apiBase = new URL(script.src).origin; } catch (e) { apiBase = ''; }

  // Per-site identity persisted in localStorage.
  var LS = 'socalchat:' + KEY;
  var store = {};
  try { store = JSON.parse(localStorage.getItem(LS) || '{}'); } catch (e) {}
  if (!store.visitor) { store.visitor = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36); save(); }
  function save() { try { localStorage.setItem(LS, JSON.stringify(store)); } catch (e) {} }

  var cursor = null;     // created_at of the last agent/system message rendered
  var status = 'ai';
  var open = false;
  var pollTimer = null;
  var greeted = false;

  var NS = 'scc';
  var css =
    '.' + NS + '-b{position:fixed;bottom:20px;right:20px;z-index:2147483000;width:60px;height:60px;border-radius:50%;border:none;background:' + ACCENT + ';color:#fff;cursor:pointer;box-shadow:0 6px 22px rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center}' +
    '.' + NS + '-b:hover{filter:brightness(1.06)}' +
    '.' + NS + '-dot{position:absolute;top:8px;right:8px;width:12px;height:12px;border-radius:50%;background:#ef4444;border:2px solid #fff;display:none}' +
    '.' + NS + '-p{position:fixed;bottom:92px;right:20px;z-index:2147483000;width:370px;max-width:calc(100vw - 32px);height:560px;max-height:calc(100vh - 120px);background:#fff;border-radius:16px;box-shadow:0 14px 44px rgba(0,0,0,.3);display:none;flex-direction:column;overflow:hidden;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}' +
    '.' + NS + '-p.open{display:flex}' +
    '.' + NS + '-h{background:' + ACCENT + ';color:#fff;padding:14px 16px}' +
    '.' + NS + '-h .t{font-weight:700;font-size:15px}' +
    '.' + NS + '-h .s{font-size:12px;opacity:.9;margin-top:2px}' +
    '.' + NS + '-h .x{position:absolute;top:12px;right:14px;cursor:pointer;opacity:.85;font-size:16px}' +
    '.' + NS + '-m{flex:1;overflow-y:auto;padding:14px;background:#f6f8fb}' +
    '.' + NS + '-row{display:flex;margin-bottom:10px}' +
    '.' + NS + '-row.me{justify-content:flex-end}' +
    '.' + NS + '-bub{max-width:82%;padding:9px 13px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}' +
    '.' + NS + '-bot .' + NS + '-bub{background:#fff;border:1px solid #e4e9f0;color:#1a2230;border-bottom-left-radius:4px}' +
    '.' + NS + '-agent .' + NS + '-bub{background:#ecfdf5;border:1px solid #a7f3d0;color:#064e3b;border-bottom-left-radius:4px}' +
    '.' + NS + '-me .' + NS + '-bub{background:' + ACCENT + ';color:#fff;border-bottom-right-radius:4px}' +
    '.' + NS + '-lbl{font-size:10px;color:#64748b;margin:0 0 3px 4px;font-weight:600;text-transform:uppercase;letter-spacing:.04em}' +
    '.' + NS + '-sys{text-align:center;color:#7a8699;font-size:12px;margin:8px 0}' +
    '.' + NS + '-ti .' + NS + '-bub{color:#8a97a7}' +
    '.' + NS + '-act{padding:6px 10px;border-top:1px solid #eef2f6;background:#fff;text-align:center}' +
    '.' + NS + '-human{background:none;border:none;color:' + ACCENT + ';font-size:12px;font-weight:600;cursor:pointer;padding:4px}' +
    '.' + NS + '-human:disabled{color:#9aa7b5;cursor:default}' +
    '.' + NS + '-i{display:flex;gap:8px;padding:10px;border-top:1px solid #e4e9f0;background:#fff}' +
    '.' + NS + '-i input{flex:1;padding:11px 13px;border:1.5px solid #e4e9f0;border-radius:10px;font-size:14px;outline:none}' +
    '.' + NS + '-i input:focus{border-color:' + ACCENT + '}' +
    '.' + NS + '-i button{border:none;background:' + ACCENT + ';color:#fff;border-radius:10px;padding:0 16px;font-weight:600;cursor:pointer}' +
    '.' + NS + '-i button:disabled{opacity:.5;cursor:default}' +
    '.' + NS + '-f{font-size:10px;color:#9aa7b5;text-align:center;padding:5px}' +
    '.' + NS + '-f a{color:#9aa7b5}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  var bubble = document.createElement('button');
  bubble.className = NS + '-b';
  bubble.setAttribute('aria-label', 'Open chat');
  bubble.innerHTML = '<span class="' + NS + '-dot"></span><svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var dot = bubble.querySelector('.' + NS + '-dot');

  var panel = document.createElement('div');
  panel.className = NS + '-p';
  panel.innerHTML =
    '<div class="' + NS + '-h" style="position:relative"><span class="' + NS + '-x">✕</span>' +
      '<div class="t">' + esc(TITLE) + '</div><div class="s" id="' + NS + '-sub">We usually reply in a moment</div></div>' +
    '<div class="' + NS + '-m" id="' + NS + '-msgs"></div>' +
    '<div class="' + NS + '-act"><button class="' + NS + '-human" id="' + NS + '-human">💬 Talk to a human</button></div>' +
    '<div class="' + NS + '-i"><input id="' + NS + '-in" type="text" placeholder="Type your message…" autocomplete="off"><button id="' + NS + '-send">Send</button></div>' +
    '<div class="' + NS + '-f">Powered by <a href="https://www.socalreceptionist.com" target="_blank" rel="noopener">SoCal Receptionist</a></div>';

  document.body.appendChild(panel);
  document.body.appendChild(bubble);

  var msgs = panel.querySelector('#' + NS + '-msgs');
  var input = panel.querySelector('#' + NS + '-in');
  var sendBtn = panel.querySelector('#' + NS + '-send');
  var humanBtn = panel.querySelector('#' + NS + '-human');
  var subEl = panel.querySelector('#' + NS + '-sub');

  bubble.addEventListener('click', function () { toggle(); });
  panel.querySelector('.' + NS + '-x').addEventListener('click', function () { toggle(false); });
  sendBtn.addEventListener('click', doSend);
  input.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSend(); });
  humanBtn.addEventListener('click', requestHuman);

  function toggle(o) {
    open = (o === undefined) ? !open : o;
    panel.classList.toggle('open', open);
    if (open) {
      dot.style.display = 'none';
      if (!greeted) { greet(); greeted = true; }
      startPolling();
      setTimeout(function () { input.focus(); }, 50);
    }
  }

  function greet() {
    addBot('Hi! Thanks for visiting' + (NAME ? ' ' + NAME : '') + '. How can I help you today?');
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function rowEl(kind, html, label) {
    var row = document.createElement('div'); row.className = NS + '-row ' + kind;
    var inner = '';
    if (label) inner += '<div class="' + NS + '-lbl">' + esc(label) + '</div>';
    inner += '<div class="' + NS + '-bub">' + html + '</div>';
    row.innerHTML = '<div>' + inner + '</div>';
    msgs.appendChild(row); msgs.scrollTop = msgs.scrollHeight; return row;
  }
  function addMe(t) { return rowEl(NS + '-me me', esc(t)); }
  function addBot(t) { return rowEl(NS + '-bot', esc(t)); }
  function addAgent(t) { return rowEl(NS + '-agent', esc(t), (NAME || 'Team') + ' · Team'); }
  function addSys(t) { var d = document.createElement('div'); d.className = NS + '-sys'; d.textContent = t; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; }

  var sending = false;
  function doSend() {
    var text = (input.value || '').trim();
    if (!text || sending) return;
    addMe(text); input.value = ''; sending = true; sendBtn.disabled = true;
    var typing = rowEl(NS + '-bot ' + NS + '-ti', '…');
    fetch(apiBase + '/widget/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: KEY, tenant: KEY, business: NAME, about: ABOUT, message: text,
        conversation: store.conversation || '', visitor: store.visitor, source_url: location.href })
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (typing.parentNode) msgs.removeChild(typing);
        if (j.conversation && j.conversation !== store.conversation) { store.conversation = j.conversation; save(); }
        if (j.status) setStatus(j.status);
        if (j.reply) { addBot(j.reply); }
        else if (j.pending) { /* a human is handling — reply arrives via poll */ }
        else if (j.error) { addSys(j.error); }
        startPolling();
      })
      .catch(function () { if (typing.parentNode) msgs.removeChild(typing); addSys('Connection error. Please try again.'); })
      .finally(function () { sending = false; sendBtn.disabled = false; input.focus(); });
  }

  function requestHuman() {
    if (!store.conversation) { addSys('Send a message first, then I can connect you.'); return; }
    humanBtn.disabled = true;
    fetch(apiBase + '/widget/chat/request-human', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation: store.conversation, visitor: store.visitor })
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j.no_human) { addSys('I’ll take your details and have someone follow up. What’s your name and best phone or email?'); humanBtn.disabled = false; return; }
        if (j.status) setStatus(j.status);
        startPolling();
      })
      .catch(function () { addSys('Could not reach the team. Please try again.'); humanBtn.disabled = false; });
  }

  function setStatus(s) {
    if (s === status) return;
    status = s;
    if (s === 'waiting') { subEl.textContent = 'Connecting you with the team…'; humanBtn.disabled = true; humanBtn.textContent = '⏳ Waiting for the team…'; }
    else if (s === 'live') { subEl.textContent = 'You’re chatting with the team'; humanBtn.style.display = 'none'; }
    else if (s === 'closed') { subEl.textContent = 'This chat has ended'; }
    else { subEl.textContent = 'We usually reply in a moment'; humanBtn.disabled = false; humanBtn.style.display = ''; humanBtn.textContent = '💬 Talk to a human'; }
  }

  function poll() {
    if (!store.conversation) return;
    var u = apiBase + '/widget/chat/poll?conversation=' + encodeURIComponent(store.conversation) +
            '&visitor=' + encodeURIComponent(store.visitor) + (cursor ? '&after=' + encodeURIComponent(cursor) : '');
    fetch(u).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (j.status) setStatus(j.status);
        (j.messages || []).forEach(function (m) {
          cursor = m.created_at;
          if (m.role === 'agent') { addAgent(m.body); if (!open) flashBubble(); }
          else if (m.role === 'system') { addSys(m.body); }
        });
      }).catch(function () {});
  }
  function flashBubble() { dot.style.display = 'block'; }

  function startPolling() {
    if (pollTimer) return;
    poll();
    pollTimer = setInterval(function () {
      // Always poll while waiting/live (catch agent replies even if panel closed);
      // while idle on AI, only poll when the panel is open.
      if (open || status === 'waiting' || status === 'live') poll();
    }, 3000);
  }
})();
