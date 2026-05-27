// Vite entry point — mounts the admin SPA into #root.

import * as Sentry from '@sentry/react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import App from './App';
import { initAnalytics } from './analytics';
import './styles/global.css';

const sentryDsn = import.meta.env.VITE_SENTRY_DSN;
if (sentryDsn) {
  Sentry.init({ dsn: sentryDsn, tracesSampleRate: 0.1, sendDefaultPii: true });
}

// Injects PostHog / GTM / GA only if VITE_ env vars are set; no-op otherwise.
initAnalytics();

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <App />
    </AuthProvider>
  </BrowserRouter>
);
