// Mandatory MFA enrollment gate.
//
// Shown once after signup/login when the account has no verified factor.
// The user MUST enroll a TOTP authenticator before accessing the app.

import { useEffect, useState } from 'react';
import { enrollTotp, verifyFactor, listFactors } from '../lib/mfa';

export default function MfaEnroll({ onDone }) {
  // 'checking' | 'enroll' | 'verify' | 'done'
  const [step, setStep] = useState('checking');
  const [qr, setQr] = useState(null);
  const [secret, setSecret] = useState(null);
  const [factorId, setFactorId] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [showSecret, setShowSecret] = useState(false);

  useEffect(() => {
    listFactors()
      .then((f) => {
        const has = f.totp.some((t) => t.status === 'verified') ||
                    f.webauthn.some((t) => t.status === 'verified');
        if (has) { onDone(); } else { beginEnroll(); }
      })
      .catch(() => onDone()); // fail open — don't lock users out
  }, []);

  async function beginEnroll() {
    setBusy(true);
    setError(null);
    try {
      const result = await enrollTotp('Authenticator');
      setQr(result.qrSvg);
      setSecret(result.secret);
      setFactorId(result.factorId);
      setStep('enroll');
    } catch (err) {
      setError(err.message || 'Could not start enrollment.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(e) {
    e.preventDefault();
    if (!code.trim() || !factorId) return;
    setBusy(true);
    setError(null);
    try {
      await verifyFactor(factorId, code.trim());
      setStep('done');
      setTimeout(() => onDone(), 800);
    } catch (err) {
      setError('Incorrect code — try again.');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'checking' || step === 'done') {
    return (
      <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh' }}>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
          {step === 'done' ? '✅ MFA set up!' : 'Loading…'}
        </p>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', minHeight: '100vh', padding: '24px' }}>
      <div className="card card-pad" style={{ maxWidth: 440, width: '100%' }}>
        <h2 style={{ marginBottom: 6 }}>Secure your account</h2>
        <p className="muted" style={{ fontSize: '0.9rem', marginBottom: 20 }}>
          Two-factor authentication is required. Scan the QR code with your authenticator app (Google Authenticator, Authy, etc.), then enter the 6-digit code below.
        </p>

        {step === 'enroll' && qr && (
          <>
            <div style={{ textAlign: 'center', marginBottom: 16 }}>
              <div dangerouslySetInnerHTML={{ __html: qr }} style={{ display: 'inline-block', background: 'white', padding: 12, borderRadius: 8 }} />
            </div>

            <button
              type="button"
              className="btn btn-ghost btn-sm"
              style={{ marginBottom: 16, fontSize: '0.8rem' }}
              onClick={() => setShowSecret((v) => !v)}
            >
              {showSecret ? 'Hide' : 'Can\'t scan? Show'} manual key
            </button>

            {showSecret && (
              <div style={{ background: 'var(--navy-2)', borderRadius: 8, padding: '10px 14px', fontFamily: 'monospace', fontSize: '0.85rem', letterSpacing: '0.05em', marginBottom: 16, wordBreak: 'break-all' }}>
                {secret}
              </div>
            )}

            {error && <div className="alert alert-error" style={{ marginBottom: 12 }}>{error}</div>}

            <form onSubmit={verify}>
              <label className="field">
                <span className="label">6-digit code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9 ]*"
                  maxLength={7}
                  autoComplete="one-time-code"
                  placeholder="000 000"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  autoFocus
                  style={{ letterSpacing: '0.15em', fontSize: '1.2rem', textAlign: 'center' }}
                />
              </label>
              <button className="btn btn-primary" type="submit" disabled={busy || code.length < 6} style={{ width: '100%' }}>
                {busy ? 'Verifying…' : 'Enable Two-Factor Auth'}
              </button>
            </form>
          </>
        )}

        {busy && step !== 'enroll' && <p className="muted" style={{ textAlign: 'center', fontSize: '0.9rem' }}>Setting up…</p>}
      </div>
    </div>
  );
}
