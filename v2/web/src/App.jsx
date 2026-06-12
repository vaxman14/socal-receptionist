// Root router — chooses the surface to render from the session + detected role.
//
//   /register (no session needed) -> <Register/>  (self-serve onboarding)
//   /welcome  (session needed)    -> <Welcome/>   (post-payment confirmation)
//   no session                    -> <Login/>
//   session, MFA still pending    -> <MfaChallenge/> (unless device is trusted)
//   session, role 'owner'         -> <OwnerApp/>  (owns its own <Routes>)
//   session, role 'client'        -> <ClientApp/> (owns its own <Routes>)
//   session, 'onboarding'         -> <Wizard/>    (re-detects role on completion)

import { useEffect, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import { useRole } from './context/useRole';
import { Loading, ErrorState } from './components/States';
import { getMfaStatus, isDeviceTrusted } from './lib/mfa';
import Login from './pages/Login';
import MfaChallenge from './pages/MfaChallenge';
import MfaEnroll from './pages/MfaEnroll';
import OwnerApp from './pages/owner/OwnerApp';
import ClientApp from './pages/client/ClientApp';
import Wizard from './pages/onboarding/Wizard';
import Register from './pages/Register';
import Welcome from './pages/Welcome';
import ResetPassword from './pages/ResetPassword';

// SessionStorage cache for MFA gate — avoids 2 network round-trips on every
// reload when the user has already cleared MFA in this browser session.
const MFA_CACHE_TTL = 10 * 60 * 1000; // 10 min

function readMfaCache(userId) {
  try {
    const raw = sessionStorage.getItem(`scr.mfa.${userId}`);
    if (!raw) return null;
    const v = JSON.parse(raw);
    if (Date.now() - v.ts < MFA_CACHE_TTL) return v;
  } catch {}
  return null;
}

function writeMfaCache(userId, hasExistingFactor) {
  try {
    sessionStorage.setItem(`scr.mfa.${userId}`, JSON.stringify({ hasExistingFactor, ts: Date.now() }));
  } catch {}
}

export default function App() {
  const { session, loading } = useAuth();
  const location = useLocation();

  // Public routes: accessible without a session.
  if (location.pathname.startsWith('/register')) return <Register />;
  if (location.pathname.startsWith('/reset-password')) return <ResetPassword />;

  if (loading) return <Loading label="Loading…" />;
  if (!session) return <Login />;

  // Welcome page — requires a session (to fetch tenant info).
  if (location.pathname.startsWith('/welcome')) return <Welcome />;

  // A session exists — but it may still be at aal1 with a verified MFA factor
  // pending. The MFA gate decides before role detection runs.
  return <MfaGate />;
}

// Decides whether the signed-in session must clear an MFA challenge before the
// app is shown. A verified factor + aal1 session means challenge — unless this
// browser holds a still-valid device-trust token, in which case MFA is skipped.
//
// Results are cached in sessionStorage to skip the network round-trips on
// subsequent page reloads within the same browser session.
function MfaGate() {
  const { session } = useAuth();
  const userId = session?.user?.id;

  // Seed from cache so the app appears immediately on reload without a spinner.
  // 'checking' | 'challenge' | 'cleared' | 'error'
  const cached = userId ? readMfaCache(userId) : null;
  const [state, setState] = useState(cached ? 'cleared' : 'checking');
  const [hasExistingFactor, setHasExistingFactor] = useState(cached?.hasExistingFactor ?? false);

  const check = useCallback(async () => {
    // Only show the spinner when there's no cached result to fall back on.
    if (!readMfaCache(userId)) setState('checking');
    try {
      const status = await getMfaStatus();
      const hasFactor = status.currentLevel === 'aal2' || status.nextLevel === 'aal2';
      setHasExistingFactor(hasFactor);
      if (!status.needed) {
        setState('cleared');
        if (userId) writeMfaCache(userId, hasFactor);
        return;
      }
      // Has a factor, session is aal1 — skip challenge only if device is trusted.
      const trusted = await isDeviceTrusted();
      if (trusted) {
        setState('cleared');
        if (userId) writeMfaCache(userId, hasFactor);
      } else {
        setState('challenge');
      }
    } catch {
      // Fail closed: unknown MFA state must not be treated as cleared.
      // The ErrorState below gives the user a retry button, so no hard lock.
      setState('error');
    }
  }, [session?.access_token, userId]);

  useEffect(() => {
    check();
  }, [check]);

  if (state === 'checking') return <Loading label="Checking security…" />;
  if (state === 'error') return <ErrorState message="Could not verify your security status. Please try again." onRetry={check} />;
  if (state === 'challenge') return <MfaChallenge onVerified={check} />;
  return <RoleRouter mfaAlreadyEnrolled={hasExistingFactor} />;
}

// Split out so useRole only runs once we know there is a session.
function RoleRouter({ mfaAlreadyEnrolled }) {
  const { role, loading, error, reload } = useRole();
  // If MfaGate confirmed a factor already exists, skip straight past enrollment.
  // This prevents a redundant "Loading…" flash on every page reload for users
  // who enrolled MFA during their initial setup.
  const [mfaReady, setMfaReady] = useState(mfaAlreadyEnrolled);

  if (loading) return <Loading label="Loading your account…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  // Wizard users skip MFA enforcement — they haven't finished setup yet.
  if (role === 'onboarding') return <Wizard onComplete={reload} />;

  // Clients and owners must have MFA enrolled before accessing the app.
  if ((role === 'owner' || role === 'client') && !mfaReady) {
    return <MfaEnroll onDone={() => setMfaReady(true)} />;
  }

  if (role === 'owner') return <OwnerApp />;
  if (role === 'client') return <ClientApp />;

  // Should not happen — role is always set once loading/error are clear.
  return <ErrorState message="Could not determine your account type." onRetry={reload} />;
}
