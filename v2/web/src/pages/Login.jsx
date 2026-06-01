// Login + sign-up screen. One form, toggled between the two modes.
// On success the router re-detects role and routes the user onward.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { ph } from '../analytics';

export default function Login() {
  const { signIn, signUp, signInWithOAuth } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    setNotice(null);

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
        // If the project requires email confirmation there is no session yet.
        if (data.session) {
          ph.identify(data.session.user.id, { email: email.trim() });
          ph.capture('signed_up');
          navigate('/', { replace: true });
        } else {
          ph.capture('signed_up_email_confirmation_required');
          setNotice(
            'Account created. Check your inbox to confirm your email, then sign in.'
          );
          setMode('signin');
        }
      }
    } catch (err) {
      setError(err?.message || 'Authentication failed. Please try again.');
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

        <h1 style={{ fontSize: '1.3rem', marginBottom: 4 }}>
          {mode === 'signin' ? 'Sign in' : 'Create your account'}
        </h1>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 18 }}>
          {mode === 'signin'
            ? 'Access your business console.'
            : 'Set up your AI receptionist in a few minutes.'}
        </p>

        {error && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 18 }}>
          <button
            type="button"
            onClick={() => signInWithOAuth('google').catch(err => setError(err?.message || 'Google sign-in failed.'))}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              border: '1px solid var(--border)', background: '#fff', color: '#3c4043',
              borderRadius: 8, padding: '10px 16px', fontWeight: 500, fontSize: '0.9rem',
              cursor: 'pointer', width: '100%',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.5 0 6.6 1.2 9.1 3.2l6.8-6.8C35.8 2.5 30.2 0 24 0 14.8 0 6.9 5.4 3.1 13.3l7.9 6.1C12.9 13.3 18 9.5 24 9.5z"/><path fill="#4285F4" d="M46.5 24.5c0-1.6-.1-3.1-.4-4.5H24v8.5h12.7c-.6 3-2.3 5.5-4.8 7.2l7.5 5.8c4.4-4 6.9-10 6.9-17z"/><path fill="#FBBC05" d="M11 28.4c-.5-1.4-.8-2.9-.8-4.4s.3-3 .8-4.4l-7.9-6.1C1.1 16.6 0 20.2 0 24s1.1 7.4 3.1 10.5l7.9-6.1z"/><path fill="#34A853" d="M24 48c6.2 0 11.4-2 15.2-5.5l-7.5-5.8c-2 1.4-4.6 2.2-7.7 2.2-6 0-11.1-3.8-13-9.1l-7.9 6.1C6.9 42.6 14.8 48 24 48z"/></svg>
            Continue with Google
          </button>
          <button
            type="button"
            onClick={() => signInWithOAuth('azure').catch(err => setError(err?.message || 'Microsoft sign-in failed.'))}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10,
              border: '1px solid var(--border)', background: '#fff', color: '#3c4043',
              borderRadius: 8, padding: '10px 16px', fontWeight: 500, fontSize: '0.9rem',
              cursor: 'pointer', width: '100%',
            }}
          >
            <svg width="18" height="18" viewBox="0 0 21 21"><rect x="1" y="1" width="9" height="9" fill="#f25022"/><rect x="11" y="1" width="9" height="9" fill="#7fba00"/><rect x="1" y="11" width="9" height="9" fill="#00a4ef"/><rect x="11" y="11" width="9" height="9" fill="#ffb900"/></svg>
            Continue with Microsoft
          </button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, color: 'var(--muted)', fontSize: '0.8rem' }}>
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
          or continue with email
          <div style={{ flex: 1, height: 1, background: 'var(--border)' }} />
        </div>

        <form onSubmit={submit}>
          <label className="field">
            <span className="label">Email</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@business.com"
            />
          </label>
          <label className="field">
            <span className="label">Password</span>
            <input
              type="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'At least 8 characters' : '••••••••'}
            />
          </label>

          <button className="btn btn-primary btn-block" disabled={busy} type="submit">
            {busy
              ? 'Please wait…'
              : mode === 'signin'
                ? 'Sign in'
                : 'Create account'}
          </button>
        </form>

        <div className="auth-toggle">
          {mode === 'signin' ? (
            <>
              New here?{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('signup');
                  setError(null);
                  setNotice(null);
                }}
              >
                Create an account
              </button>
            </>
          ) : (
            <>
              Already have an account?{' '}
              <button
                type="button"
                onClick={() => {
                  setMode('signin');
                  setError(null);
                  setNotice(null);
                }}
              >
                Sign in
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
