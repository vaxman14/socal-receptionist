// Wizard step 3 — mandatory TOTP setup.
// The user must enroll and verify a TOTP factor before they can continue.

import { useState, useEffect } from 'react';
import { enrollTotp, verifyFactor, listFactors } from '../../lib/mfa';

export default function StepMfa({ onVerified }) {
  const [status, setStatus] = useState('checking'); // checking | enroll | verify | done
  const [enroll, setEnroll] = useState(null); // { factorId, qrSvg, secret }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    listFactors().then((f) => {
      if (f.totp.length > 0) {
        setStatus('done');
        onVerified();
      } else {
        setStatus('enroll');
      }
    }).catch(() => setStatus('enroll'));
  }, []);

  const startEnroll = async () => {
    setBusy(true);
    setError(null);
    try {
      const data = await enrollTotp('SoCal Receptionist');
      setEnroll(data);
      setStatus('verify');
    } catch (err) {
      setError(err?.message || 'Could not start enrollment. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e) => {
    e.preventDefault();
    if (!code.trim()) { setError('Enter the 6-digit code from your authenticator app.'); return; }
    setBusy(true);
    setError(null);
    try {
      await verifyFactor(enroll.factorId, code.trim());
      setStatus('done');
      onVerified();
    } catch (err) {
      setError(err?.message || 'Incorrect code. Try again.');
      setCode('');
    } finally {
      setBusy(false);
    }
  };

  if (status === 'checking') return <p className="muted">Checking security settings…</p>;

  if (status === 'enroll') {
    return (
      <div>
        <h2 style={{ fontSize: '1.2rem', marginBottom: 8 }}>Secure your account</h2>
        <p className="muted" style={{ marginBottom: 20 }}>
          Two-factor authentication is required. You'll need an authenticator app like Google Authenticator or Authy.
        </p>
        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}
        <button className="btn btn-primary btn-block" onClick={startEnroll} disabled={busy}>
          {busy ? 'Setting up…' : 'Set up authenticator app →'}
        </button>
      </div>
    );
  }

  if (status === 'verify') {
    return (
      <div>
        <h2 style={{ fontSize: '1.2rem', marginBottom: 8 }}>Scan the QR code</h2>
        <p className="muted" style={{ marginBottom: 16 }}>
          Open your authenticator app and scan this code, then enter the 6-digit code to confirm.
        </p>

        {enroll?.qrSvg && (
          <div style={{ textAlign: 'center', marginBottom: 16 }}>
            <img src={enroll.qrSvg} alt="QR code" style={{ width: 180, height: 180, border: '1px solid var(--border)' }} />
          </div>
        )}

        {enroll?.secret && (
          <p className="muted" style={{ fontSize: '0.8rem', marginBottom: 20, wordBreak: 'break-all', textAlign: 'center' }}>
            Manual entry: <code style={{ userSelect: 'all' }}>{enroll.secret}</code>
          </p>
        )}

        {error && <div className="alert alert-error" style={{ marginBottom: 16 }}>{error}</div>}

        <form onSubmit={verify}>
          <label className="field">
            <span className="label">6-digit code</span>
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
              placeholder="000000"
              style={{ letterSpacing: '0.3em', fontSize: '1.2rem', textAlign: 'center' }}
              autoFocus
            />
          </label>
          <button className="btn btn-primary btn-block" type="submit" disabled={busy}>
            {busy ? 'Verifying…' : 'Confirm & continue →'}
          </button>
        </form>
      </div>
    );
  }

  return null;
}
