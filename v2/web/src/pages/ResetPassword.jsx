import { useState } from 'react';
import { useAuth } from '../context/AuthContext';

const PW_RULES = [
  { label: 'At least 8 characters',   test: (p) => p.length >= 8 },
  { label: 'Uppercase letter (A–Z)',   test: (p) => /[A-Z]/.test(p) },
  { label: 'Lowercase letter (a–z)',   test: (p) => /[a-z]/.test(p) },
  { label: 'Number (0–9)',             test: (p) => /[0-9]/.test(p) },
  { label: 'Special character (!@#…)', test: (p) => /[^A-Za-z0-9]/.test(p) },
];

export default function ResetPassword() {
  const { updatePassword, clearRecoveryMode } = useAuth();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(false);

  const allMet = PW_RULES.every((r) => r.test(password));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);
    if (!allMet) { setError('Password does not meet requirements.'); return; }
    if (password !== confirm) { setError('Passwords do not match.'); return; }
    setBusy(true);
    try {
      await updatePassword(password);
      setDone(true);
    } catch (err) {
      setError(err?.message || 'Failed to update password. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <div className="centered">
        <div className="auth-card">
          <div className="brand">
            <img src="/logo-icon.svg" alt="" />
            <span className="name">SoCal Receptionist<small>Admin Console</small></span>
          </div>
          <h1 style={{ fontSize: '1.3rem', marginBottom: 8 }}>Password updated</h1>
          <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 20 }}>
            Your password has been changed. You're now signed in.
          </p>
          <button className="btn btn-primary btn-block" onClick={clearRecoveryMode}>
            Go to dashboard
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="centered">
      <div className="auth-card">
        <div className="brand">
          <img src="/logo-icon.svg" alt="" />
          <span className="name">SoCal Receptionist<small>Admin Console</small></span>
        </div>
        <h1 style={{ fontSize: '1.3rem', marginBottom: 4 }}>Set new password</h1>
        <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 18 }}>
          Choose a strong password for your account.
        </p>

        {error && <div className="alert alert-error">{error}</div>}

        <form onSubmit={submit}>
          <label className="field">
            <span className="label">New password</span>
            <input
              type="password"
              name="new-password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Create a strong password"
            />
          </label>

          {password.length > 0 && (
            <ul className="pw-checklist">
              {PW_RULES.map((r) => (
                <li key={r.label} className={r.test(password) ? 'met' : ''}>
                  {r.test(password) ? '✓' : '○'} {r.label}
                </li>
              ))}
            </ul>
          )}

          <label className="field">
            <span className="label">Confirm password</span>
            <input
              type="password"
              name="confirm-password"
              autoComplete="new-password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder="Repeat your new password"
            />
          </label>

          <button className="btn btn-primary btn-block" disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Update password'}
          </button>
        </form>
      </div>
    </div>
  );
}
