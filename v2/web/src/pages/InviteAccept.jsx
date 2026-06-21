// Public invite acceptance. Rendered for /invite/:token (no session required).
// The user sets their full name + password; MFA is enforced by the app on their
// first sign-in afterward.

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Loading } from '../components/States';

function tokenFromUrl() {
  const m = window.location.pathname.match(/\/invite\/([^/?#]+)/);
  return m ? m[1] : null;
}

export default function InviteAccept() {
  const token = tokenFromUrl();
  const [info, setInfo] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      if (!token) { setLoadErr('Invalid invite link.'); return; }
      try {
        const r = await api.get(`/invite/${token}`);
        if (alive) setInfo(r);
      } catch (e) {
        if (alive) setLoadErr(e.message || 'Could not load this invite.');
      }
    })();
    return () => { alive = false; };
  }, [token]);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.post(`/invite/${token}/accept`, { full_name: fullName.trim(), password });
      setDone(true);
    } catch (e2) {
      setErr(e2.message || 'Could not accept the invite.');
    } finally {
      setBusy(false);
    }
  }

  if (loadErr) {
    return <div className="auth-shell"><div className="auth-card"><h1>Invitation</h1><p className="state">{loadErr}</p></div></div>;
  }
  if (!info) return <Loading label="Loading your invitation…" />;

  if (done || info.accepted) {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>You're all set</h1>
          <p>Your account is ready. Sign in to finish setup (you'll be asked to enable two-factor authentication).</p>
          <a className="btn btn-primary btn-block" href="/login">Go to sign in</a>
        </div>
      </div>
    );
  }

  if (info.expired) {
    return <div className="auth-shell"><div className="auth-card"><h1>Invitation expired</h1><p className="state">Ask the account owner to send a fresh invite.</p></div></div>;
  }

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Join {info.tenant_name}</h1>
        <p className="muted">Setting up the account for <strong>{info.email}</strong>.</p>
        {err && <p className="state" style={{ color: 'var(--red, #c0392b)' }}>{err}</p>}
        <form onSubmit={submit}>
          <label>Full name
            <input type="text" required value={fullName} onChange={(e) => setFullName(e.target.value)} disabled={busy} autoComplete="name" />
          </label>
          <label>Password
            <input type="password" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} disabled={busy} autoComplete="new-password" placeholder="At least 8 characters" />
          </label>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Creating your account…' : 'Accept invitation'}
          </button>
        </form>
        <p className="muted" style={{ fontSize: '0.8rem', marginTop: 12 }}>
          After this you'll sign in and set up two-factor authentication.
        </p>
      </div>
    </div>
  );
}
