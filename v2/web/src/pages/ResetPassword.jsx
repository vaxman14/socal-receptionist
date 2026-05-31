// Landing page for the Supabase password-reset email link.
// Supabase automatically signs the user in via the recovery token in the URL;
// we just show a form to set the new password.

import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { supabase } from '../lib/supabase';

export default function ResetPassword() {
  const { updatePassword } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    // PKCE flow: exchange the ?code= param for a session
    const code = new URLSearchParams(window.location.search).get('code');
    if (code) {
      supabase.auth.exchangeCodeForSession(code)
        .then(({ error }) => {
          if (error) setError('Reset link is invalid or expired. Request a new one.');
          else setReady(true);
        });
    } else {
      // Implicit flow fallback: session already set by onAuthStateChange
      supabase.auth.getSession().then(({ data }) => {
        if (data?.session) setReady(true);
        else setError('Reset link is invalid or expired. Request a new one.');
      });
    }
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (password.length < 8) { setError('Password must be at least 8 characters.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }

    setBusy(true);
    try {
      await updatePassword(password);
      setDone(true);
      setTimeout(() => navigate('/', { replace: true }), 2000);
    } catch (err) {
      setError(err?.message || 'Could not update password. Try again.');
    } finally {
      setBusy(false);
    }
  };

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

        <h1 style={{ fontSize: '1.3rem', marginBottom: 4 }}>Set a new password</h1>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 18 }}>
          Choose something strong — at least 8 characters.
        </p>

        {error && <div className="alert alert-error">{error}</div>}
        {done && <div className="alert alert-success">Password updated! Redirecting…</div>}

        {!ready && !error && !done && (
          <p className="muted" style={{ fontSize: '0.88rem' }}>Verifying reset link…</p>
        )}

        {ready && !done && (
          <form onSubmit={submit}>
            <label className="field">
              <span className="label">New password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="At least 8 characters"
              />
            </label>
            <label className="field">
              <span className="label">Confirm password</span>
              <input
                type="password"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                placeholder="Same password again"
              />
            </label>
            <button className="btn btn-primary btn-block" disabled={busy} type="submit">
              {busy ? 'Saving…' : 'Update password'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
