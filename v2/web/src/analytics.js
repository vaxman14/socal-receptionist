// Optional analytics / tag injection for the admin SPA.
//
// PostHog, GTM, and GA4 load only when VITE_ env vars are set at build time.
// Re-export `ph` (posthog instance) so any module can call ph.capture(...)
// safely — it's a no-op when PostHog is not initialized.

import posthog from 'posthog-js';

export { posthog as ph };

export function initAnalytics() {
  const phKey = import.meta.env.VITE_POSTHOG_KEY;
  if (phKey) {
    posthog.init(phKey, {
      api_host: 'https://us.i.posthog.com',
      defaults: '2026-01-30',
      person_profiles: 'identified_only',
    });
  }

  const gtmId = import.meta.env.VITE_GTM_ID;
  const gaId = import.meta.env.VITE_GA_ID;

  if (gtmId) {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push({ 'gtm.start': Date.now(), event: 'gtm.js' });
    const s = document.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtm.js?id=${gtmId}`;
    document.head.appendChild(s);
  }

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
