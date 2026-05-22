// Optional analytics / tag injection for the admin SPA.
//
// Drops in Google Tag Manager and/or GA4 only when an ID is configured via a
// VITE_ build env var. No ID set => no-op: no script tag, no network call.
// Mirrors the env-driven tag slots on the V1 marketing site.
//
// VITE_ vars are baked at BUILD time — set them before `npm run build`
// (locally, or as Netlify env vars for the deployed app), not at runtime.

export function initAnalytics() {
  const gtmId = import.meta.env.VITE_GTM_ID;
  const gaId = import.meta.env.VITE_GA_ID;

  // Google Tag Manager — use this if you run a GTM container (recommended:
  // lets you manage GA, Facebook Pixel, etc. without code changes).
  if (gtmId) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtm.js?id=${gtmId}`;
    document.head.appendChild(s);
  }

  // Direct GA4 (gtag.js) — use this instead if you only want Analytics and
  // don't run a Tag Manager container.
  if (gaId) {
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${gaId}`;
    document.head.appendChild(s);
    window.dataLayer = window.dataLayer || [];
    function gtag() { window.dataLayer.push(arguments); }
    gtag('js', new Date());
    gtag('config', gaId);
  }
}
