// Login + sign-up screen. One form, toggled between the two modes.
// On success the router re-detects role and routes the user onward.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ph } from '../analytics';

export default function Login() {
  const { signIn, signUp, forgotPassword } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState('signin'); // 'signin' | 'signup' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const switchMode = (next) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

    if (mode === 'forgot') {
      if (!email.trim()) { setError('Enter your email address.'); return; }
      setBusy(true);
      try {
        await forgotPassword(email.trim());
        switchMode('signin');
        setNotice('✅ Password reset link sent! Check your inbox.');
      } catch (err) {
        setError(err?.message || 'Could not send reset email. Try again.');
      } finally {
        setBusy(false);
      }
      return;
    }

    if (!email.trim() || !password) {
      setError('Email and password are required.');
      return;
    }
    if (mode === 'signup' && password.length < 8) {
      setError('Choose a password of at least 8 characters.');
      return;
    }

    setBusy(true);
    try {
      if (mode === 'signin') {
        const data = await signIn(email.trim(), password);
        ph.identify(data?.session?.user?.id, { email: email.trim() });
        ph.capture('signed_in');
        navigate('/', { replace: true });
      } else {
        const data = await signUp(email.trim(), password);
        if (data.session) {
          ph.identify(data.session.user.id, { email: email.trim() });
          ph.capture('signed_up');
          navigate('/', { replace: true });
        } else {
          ph.capture('signed_up_email_confirmation_required');
          setNotice('Account created. Check your inbox to confirm your email, then sign in.');
          switchMode('signin');
        }
      }
    } catch (err) {
      setError(err?.message || 'Authentication failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const titles = {
    signin: 'Sign in',
    signup: 'Create your account',
    forgot: 'Reset your password',
  };
  const subtitles = {
    signin: 'Access your business console.',
    signup: 'Set up your AI receptionist in a few minutes.',
    forgot: "Enter your email and we'll send a reset link.",
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

        <h1 style={{ fontSize: '1.3rem', marginBottom: 4 }}>{titles[mode]}</h1>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 18 }}>
          {subtitles[mode]}
        </p>

        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

        <form onSubmit={submit}>
          <label className="field">
            <span className="label">Email</span>
            <input
              id="email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@business.com"
            />
          </label>

          {mode !== 'forgot' && (
            <label className="field">
              <span className="label">Password</span>
              <input
                id="password"
                type="password"
                autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
              />
            </label>
          )}

          {mode === 'signin' && (
            <div style={{ textAlign: 'right', marginTop: -8, marginBottom: 12 }}>
              <button
                type="button"
                onClick={() => switchMode('forgot')}
                style={{ background: 'none', border: 'none', color: 'var(--green-dark)', font: 'inherit', fontWeight: 600, cursor: 'pointer', fontSize: '0.82rem', padding: 0 }}
              >
                Forgot password?
              </button>
            </div>
          )}

          <button className="btn btn-primary btn-block" disabled={busy} type="submit">
            {busy
              ? 'Please wait…'
              : mode === 'signin'
                ? 'Sign in'
                : mode === 'signup'
                  ? 'Create account'
                  : 'Send reset link'}
          </button>
        </form>

        <div className="auth-toggle">
          {mode === 'signin' ? (
            <>
              New here?{' '}
              <button type="button" onClick={() => switchMode('signup')}>
                Create an account
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => switchMode('signin')}>
                Back to sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
