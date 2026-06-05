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

export default function App() {
  const { session, loading } = useAuth();
  const location = useLocation();

  // Public routes: accessible without a session.
  if (location.pathname.startsWith('/register')) return <Register />;

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
function MfaGate() {
  const { session } = useAuth();
  // 'checking' | 'challenge' | 'cleared'
  const [state, setState] = useState('checking');
  // True when the user already has an enrolled factor — lets RoleRouter skip
  // the MfaEnroll check and avoid the redundant "Loading…" flash every reload.
  const [hasExistingFactor, setHasExistingFactor] = useState(false);

  const check = useCallback(async () => {
    setState('checking');
    try {
      const status = await getMfaStatus();
      // nextLevel 'aal2' means there's a verified factor; currentLevel 'aal2'
      // means the session already cleared it this run.
      setHasExistingFactor(
        status.currentLevel === 'aal2' || status.nextLevel === 'aal2'
      );
      if (!status.needed) {
        // No verified factor, or already at aal2 — nothing to do.
        setState('cleared');
        return;
      }
      // The account has a verified factor and the session is aal1. Skip the
      // challenge only if this device is still trusted.
      const trusted = await isDeviceTrusted();
      setState(trusted ? 'cleared' : 'challenge');
    } catch {
      // If the assurance-level lookup fails, fail open to the app rather than
      // hard-locking the user out — AAL2-gated routes (if any) still enforce
      // server-side. The far more common case is "no factor enrolled".
      setState('cleared');
    }
    // Re-run whenever the underlying session changes (sign-in, factor verify).
  }, [session?.access_token]);

  useEffect(() => {
    check();
  }, [check]);

  if (state === 'checking') return <Loading label="Checking security…" />;
  if (state === 'challenge') {
    // onVerified: the factor was cleared (session is now aal2) — re-check and
    // fall through to the app.
    return <MfaChallenge onVerified={check} />;
  }
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
