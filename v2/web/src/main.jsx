// Vite entry point — mounts the admin SPA into #root.

import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { AuthProvider } from './context/AuthContext';
import App from './App';
import { initAnalytics } from './analytics';
import './styles/global.css';

// Injects GTM / GA only if VITE_GTM_ID / VITE_GA_ID are set; no-op otherwise.
initAnalytics();

createRoot(document.getElementById('root')).render(
  <BrowserRouter>
    <AuthProvider>
      <App />
    </AuthProvider>
  </BrowserRouter>
);
