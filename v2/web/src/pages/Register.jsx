// Public account creation. Business setup happens after sign-in through the
// conversational onboarding wizard, so there is one self-serve path.

import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { ph } from '../analytics';

export default function Register() {
  const { signIn, signUp } = useAuth();
  const [form, setForm] = useState({ fullName: '', email: '', password: '', confirm: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [checkEmail, setCheckEmail] = useState(false);

  const set = (key) => (event) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function submit(event) {
    event.preventDefault();
    setError(null);
    if (!form.fullName.trim()) return setError('Full name is required.');
    if (!form.email.trim()) return setError('Email is required.');
    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    if (form.password !== form.confirm) return setError('Passwords do not match.');

    setBusy(true);
    try {
      let session;
      try {
        const data = await signUp(form.email.trim(), form.password);
        session = data.session;
        if (!session) {
          setCheckEmail(true);
          return;
        }
      } catch (signUpError) {
        if (!/already registered|already exists/i.test(signUpError?.message || '')) throw signUpError;
        const data = await signIn(form.email.trim(), form.password);
        session = data.session;
      }

      ph.identify(session?.user?.id, { email: form.email.trim(), name: form.fullName.trim() });
      ph.capture('registration_account_created');
      window.location.replace('/');
    } catch (err) {
      setError(err?.message || 'Could not create your account. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="wizard-wrap">
      <div className="wizard-inner">
        <div className="wizard-top">
          <a href="/" className="wizard-brand" style={{ textDecoration: 'none' }}>
            <img src="/logo-icon.svg" alt="" />
            <span className="name">SoCal Receptionist</span>
          </a>
          <a href="/login" className="btn btn-ghost btn-sm">Sign in</a>
        </div>

        <div className="card card-pad">
          <h1 style={{ marginBottom: 6 }}>Start your 30-day free trial</h1>
          <p className="muted" style={{ marginBottom: 20, fontSize: '0.92rem' }}>
            Create your account, then our AI setup assistant will configure your receptionist through a short conversation. No credit card required.
          </p>

          {checkEmail ? (
            <div className="alert alert-success">
              Check your inbox to confirm your email, then sign in to finish setup.
            </div>
          ) : (
            <form onSubmit={submit}>
              {error && <div className="alert alert-error">{error}</div>}
              <label className="field">
                <span className="label">Full name *</span>
                <input type="text" autoComplete="name" value={form.fullName} onChange={set('fullName')} placeholder="Jane Smith" />
              </label>
              <label className="field">
                <span className="label">Email address *</span>
                <input type="email" autoComplete="email" value={form.email} onChange={set('email')} placeholder="jane@yourbusiness.com" />
              </label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                <label className="field">
                  <span className="label">Password *</span>
                  <input type="password" autoComplete="new-password" value={form.password} onChange={set('password')} placeholder="At least 8 characters" />
                </label>
                <label className="field">
                  <span className="label">Confirm password *</span>
                  <input type="password" autoComplete="new-password" value={form.confirm} onChange={set('confirm')} placeholder="Repeat password" />
                </label>
              </div>
              <button className="btn btn-primary btn-block" disabled={busy} type="submit">
                {busy ? 'Creating account…' : 'Create account & start setup →'}
              </button>
              <p className="muted" style={{ fontSize: '0.78rem', textAlign: 'center', marginTop: 12 }}>
                After 30 days, choose $69/month or $690/year. Cancel anytime.
              </p>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
