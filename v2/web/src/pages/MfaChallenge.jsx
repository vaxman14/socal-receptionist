// MFA challenge screen.
//
// Shown after a successful password sign-in when the account has a verified
// TOTP factor and the session is still at aal1 (see App.jsx). Clearing a factor
// here elevates the session to aal2 and the router falls through to the app.
//
// Also offers "trust this device for 30 days" (mints a backend trust token so
// future sign-ins on this browser skip this screen) and an account-recovery
// link for the "lost my authenticator" path.

import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase';
import {
  listFactors,
  verifyFactor,
  authenticatePasskey,
  trustThisDevice,
} from '../lib/mfa';

export default function MfaChallenge({ onVerified }) {
  const [factors, setFactors] = useState(null);
  const [code, setCode] = useState('');
  const [trust, setTrust] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);

  // Account-recovery ("lost my authenticator") sub-flow.
  const [recoverMode, setRecoverMode] = useState(false);
  const [recoverEmail, setRecoverEmail] = useState('');
  const [recoverSent, setRecoverSent] = useState(false);

  useEffect(() => {
    let active = true;
    listFactors()
      .then((f) => {
        if (active) setFactors(f);
      })
      .catch((err) => {
        if (active) setLoadError(err?.message || 'Could not load your security factors.');
      });
    return () => {
      active = false;
    };
  }, []);

  // Common post-verify step: optionally trust the device, then hand control
  // back to the router (which re-reads the now-aal2 session).
  const afterVerified = async () => {
    if (trust) {
      try {
        await trustThisDevice();
      } catch {
        // Non-fatal — the user is still elevated, they just won't be remembered.
      }
    }
    onVerified();
  };

  const submitCode = async (e) => {
    e.preventDefault();
    setError(null);

    const totp = factors?.totp?.find((f) => f.status === 'verified');
    if (!totp) {
      setError('No authenticator app is set up on this account.');
      return;
    }
    if (!/^\d{6}$/.test(code.replace(/\s/g, ''))) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }

    setBusy(true);
    try {
      await verifyFactor(totp.id, code);
      await afterVerified();
    } catch (err) {
      setError(err?.message || 'That code was not accepted. Please try again.');
      setBusy(false);
    }
  };

  const usePasskey = async () => {
    setError(null);
    const passkey = factors?.webauthn?.find((f) => f.status === 'verified');
    if (!passkey) {
      setError('No passkey is set up on this account.');
      return;
    }
    setBusy(true);
    try {
      await authenticatePasskey(passkey.id);
      await afterVerified();
    } catch (err) {
      setError(err?.message || 'Passkey sign-in failed. Try your authenticator code.');
      setBusy(false);
    }
  };

  // "Lost my authenticator" — send a magic-link / email OTP. Signing in through
  // that link re-authenticates the user; from Settings they can then remove the
  // lost factor. Supabase has no email *factor*, so this is a recovery path,
  // not a redundant second factor.
  const sendRecovery = async (e) => {
    e.preventDefault();
    setError(null);
    if (!recoverEmail.trim()) {
      setError('Enter the email address on your account.');
      return;
    }
    setBusy(true);
    try {
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: recoverEmail.trim(),
        options: { shouldCreateUser: false },
      });
      if (otpError) throw otpError;
      setRecoverSent(true);
    } catch (err) {
      setError(err?.message || 'Could not send the recovery email.');
    } finally {
      setBusy(false);
    }
  };

  const signOut = () => supabase.auth.signOut();

  return (
    <div className="centered">
      <div className="auth-card">
        <div className="brand">
          <img src="/logo-icon.svg" alt="" />
          <span className="name">
            SoCal Receptionist
            <small>Admin Console</small>
          </span>
        </div>

        {recoverMode ? (
          <>
            <h1 style={{ fontSize: '1.3rem', marginBottom: 4 }}>Account recovery</h1>
            <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 18 }}>
              Lost access to your authenticator? We'll email you a secure sign-in
              link. Once you're in, remove the old authenticator from Settings.
            </p>

            {error && <div className="alert alert-error">{error}</div>}
            {recoverSent ? (
              <div className="alert alert-success">
                Check your inbox — we sent a sign-in link to{' '}
                <strong>{recoverEmail.trim()}</strong>. It may take a minute to
                arrive.
              </div>
            ) : (
              <form onSubmit={sendRecovery}>
                <label className="field">
                  <span className="label">Account email</span>
                  <input
                    type="email"
                    autoComplete="email"
                    value={recoverEmail}
                    onChange={(e) => setRecoverEmail(e.target.value)}
                    placeholder="you@business.com"
                  />
                </label>
                <button
                  className="btn btn-primary btn-block"
                  disabled={busy}
                  type="submit"
                >
                  {busy ? 'Sending…' : 'Email me a sign-in link'}
                </button>
              </form>
            )}

            <div className="auth-toggle">
              <button
                type="button"
                onClick={() => {
                  setRecoverMode(false);
                  setError(null);
                  setRecoverSent(false);
                }}
              >
                Back to verification
              </button>
            </div>
          </>
        ) : (
          <>
            <h1 style={{ fontSize: '1.3rem', marginBottom: 4 }}>Verify it's you</h1>
            <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 18 }}>
              Enter the 6-digit code from your authenticator app to finish
              signing in.
            </p>

            {loadError && <div className="alert alert-error">{loadError}</div>}
            {error && <div className="alert alert-error">{error}</div>}

            <form onSubmit={submitCode}>
              <label className="field">
                <span className="label">Authentication code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  maxLength={7}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="123456"
                  autoFocus
                />
              </label>

              <label className="checkbox" style={{ marginBottom: 14 }}>
                <input
                  type="checkbox"
                  checked={trust}
                  onChange={(e) => setTrust(e.target.checked)}
                />
                <span>Trust this device for 30 days</span>
              </label>

              <button
                className="btn btn-primary btn-block"
                disabled={busy || !factors}
                type="submit"
              >
                {busy ? 'Verifying…' : 'Verify'}
              </button>
            </form>

            {factors?.webauthn?.some((f) => f.status === 'verified') && (
              <button
                type="button"
                className="btn btn-secondary btn-block"
                style={{ marginTop: 10 }}
                disabled={busy}
                onClick={usePasskey}
              >
                Use a passkey instead
              </button>
            )}

            <div className="auth-toggle">
              <button type="button" onClick={() => setRecoverMode(true)}>
                Lost your authenticator?
              </button>
              <span style={{ margin: '0 6px' }}>·</span>
              <button type="button" onClick={signOut}>
                Sign in as someone else
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
