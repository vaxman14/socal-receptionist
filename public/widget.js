/* SoCal Receptionist embeddable chat widget loader.
   Usage on any site:
   <script src="https://www.socalreceptionist.com/widget.js"
           data-name="Your Business"
           data-about="What you do, hours, anything the AI should know"
           data-accent="#2b6cb0"
           data-tenant="optional-id"></script>
*/
(function () {
  var s = document.currentScript;
  if (!s) { var all = document.getElementsByTagName('script'); s = all[all.length - 1]; }
  var BASE = (s && s.src ? s.src.replace(/\/widget\.js.*$/, '') : 'https://www.socalreceptionist.com');
  var name = (s && s.getAttribute('data-name')) || '';
  var about = (s && s.getAttribute('data-about')) || '';
  var accent = (s && s.getAttribute('data-accent')) || '#2b6cb0';
  var tenant = (s && s.getAttribute('data-tenant')) || '';

  var q = '?name=' + encodeURIComponent(name) + '&about=' + encodeURIComponent(about) +
          '&accent=' + encodeURIComponent(accent) + '&tenant=' + encodeURIComponent(tenant);

  var open = false;

  // launcher button
  var btn = document.createElement('button');
  btn.setAttribute('aria-label', 'Open chat');
  btn.style.cssText = 'position:fixed;bottom:20px;right:20px;width:60px;height:60px;border-radius:50%;border:0;' +
    'background:' + accent + ';color:#fff;cursor:pointer;z-index:2147483646;box-shadow:0 6px 22px rgba(0,0,0,.25);' +
    'display:flex;align-items:center;justify-content:center;transition:transform .15s;';
  btn.onmouseenter = function () { btn.style.transform = 'scale(1.06)'; };
  btn.onmouseleave = function () { btn.style.transform = 'scale(1)'; };
  var ICON_CHAT = '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
  var ICON_CLOSE = '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
  btn.innerHTML = ICON_CHAT;

  // chat iframe
  var frame = document.createElement('iframe');
  frame.title = 'Chat';
  frame.src = BASE + '/widget-frame.html' + q;
  frame.style.cssText = 'position:fixed;bottom:92px;right:20px;width:380px;height:560px;max-width:calc(100vw - 32px);' +
    'max-height:calc(100vh - 120px);border:0;border-radius:16px;z-index:2147483646;' +
    'box-shadow:0 12px 40px rgba(0,0,0,.28);display:none;background:#fff;';

  function toggle() {
    open = !open;
    frame.style.display = open ? 'block' : 'none';
    btn.innerHTML = open ? ICON_CLOSE : ICON_CHAT;
  }
  btn.addEventListener('click', toggle);

  function mount() {
    document.body.appendChild(frame);
    document.body.appendChild(btn);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
