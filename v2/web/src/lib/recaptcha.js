const SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY;

let loaded = false;
let loading = null;

function loadScript() {
  if (loaded) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = `https://www.google.com/recaptcha/api.js?render=${SITE_KEY}`;
    s.onload = () => { loaded = true; resolve(); };
    s.onerror = reject;
    document.head.appendChild(s);
  });
  return loading;
}

export async function getRecaptchaToken(action = 'submit') {
  if (!SITE_KEY) return null;
  await loadScript();
  return new Promise((resolve, reject) => {
    window.grecaptcha.ready(() => {
      window.grecaptcha.execute(SITE_KEY, { action }).then(resolve).catch(reject);
    });
  });
}
