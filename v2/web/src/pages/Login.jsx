// Login + sign-up screen. One form, toggled between the two modes.
// On success the router re-detects role and routes the user onward.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const PW_RULES = [
  { label: 'At least 8 characters',      test: (p) => p.length >= 8 },
  { label: 'Uppercase letter (A–Z)',      test: (p) => /[A-Z]/.test(p) },
  { label: 'Lowercase letter (a–z)',      test: (p) => /[a-z]/.test(p) },
  { label: 'Number (0–9)',                test: (p) => /[0-9]/.test(p) },
  { label: 'Special character (!@#…)',    test: (p) => /[^A-Za-z0-9]/.test(p) },
];

function validatePassword(pw) {
  for (const rule of PW_RULES) {
    if (!rule.test(pw)) return rule.label + ' required.';
  }
  return null;
}

export default function Login() {
  const { signIn, signUp, signInWithOAuth } = useAuth();
  const navigate = useNavigate();

  const [mode, setMode] = useState('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [oauthBusy, setOauthBusy] = useState(null);
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

    if (mode === 'signup') {
      const pwError = validatePassword(password);
      if (pwError) { setError(pwError); return; }
    }

    setBusy(true);
    try {
      if (mode === 'signin') {
        await signIn(email.trim(), password);
        navigate('/', { replace: true });
      } else {
        const data = await signUp(email.trim(), password);
        if (data.session) {
          navigate('/', { replace: true });
        } else {
          setNotice('Account created. Check your inbox to confirm your email, then sign in.');
          setMode('signin');
        }
      }
    } catch (err) {
      setError(err?.message || 'Authentication failed. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleOAuth = async (provider) => {
    setError(null);
    setOauthBusy(provider);
    try {
      await signInWithOAuth(provider);
      // browser will redirect — no further action needed
    } catch (err) {
      setError(err?.message || 'Social sign-in failed. Please try again.');
      setOauthBusy(null);
    }
  };

  const switchMode = (next) => {
    setMode(next);
    setError(null);
    setNotice(null);
  };

  const showPwChecklist = mode === 'signup' && password.length > 0;

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

        {error  && <div className="alert alert-error">{error}</div>}
        {notice && <div className="alert alert-success">{notice}</div>}

        {/* Social sign-on */}
        <div className="oauth-row">
          <button
            type="button"
            className="btn btn-oauth"
            disabled={!!oauthBusy}
            onClick={() => handleOAuth('google')}
          >
            <GoogleIcon />
            {oauthBusy === 'google' ? 'Redirecting…' : 'Continue with Google'}
          </button>
          <button
            type="button"
            className="btn btn-oauth"
            disabled={!!oauthBusy}
            onClick={() => handleOAuth('azure')}
          >
            <MicrosoftIcon />
            {oauthBusy === 'azure' ? 'Redirecting…' : 'Continue with Microsoft'}
          </button>
        </div>

        <div className="oauth-divider"><span>or</span></div>

        <form onSubmit={submit}>
          <label className="field">
            <span className="label">Email</span>
            <input
              type="email"
              name="email"
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
              name="password"
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={mode === 'signup' ? 'Create a strong password' : '••••••••'}
            />
          </label>

          {showPwChecklist && (
            <ul className="pw-checklist">
              {PW_RULES.map((r) => (
                <li key={r.label} className={r.test(password) ? 'met' : ''}>
                  {r.test(password) ? '✓' : '○'} {r.label}
                </li>
              ))}
            </ul>
          )}

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
            <>New here? <button type="button" onClick={() => switchMode('signup')}>Create an account</button></>
          ) : (
            <>Already have an account? <button type="button" onClick={() => switchMode('signin')}>Sign in</button></>
          )}
        </div>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <path d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z" fill="#4285F4"/>
      <path d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z" fill="#34A853"/>
      <path d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z" fill="#FBBC05"/>
      <path d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z" fill="#EA4335"/>
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" fill="none" aria-hidden="true">
      <rect x="1" y="1" width="7.5" height="7.5" fill="#F35325"/>
      <rect x="9.5" y="1" width="7.5" height="7.5" fill="#81BC06"/>
      <rect x="1" y="9.5" width="7.5" height="7.5" fill="#05A6F0"/>
      <rect x="9.5" y="9.5" width="7.5" height="7.5" fill="#FFBA08"/>
    </svg>
  );
}
