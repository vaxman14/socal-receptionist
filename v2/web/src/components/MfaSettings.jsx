// Security section for the client Settings page.
//
// Four blocks:
//   * Email OTP — enroll, verify, unenroll.
//   * Authenticator app (TOTP) — enroll (QR + secret), verify, list, unenroll.
//   * Passkeys — enroll + list + remove if the Supabase project supports the
//     WebAuthn factor; otherwise a "coming soon" state (see notes below).
//   * Trusted devices — list + revoke the "trust this device for 30 days"
//     grants minted at the MFA challenge.

import { useEffect, useState, useCallback } from 'react';
import {
  listFactors,
  enrollTotp,
  enrollEmail,
  verifyFactor,
  unenrollFactor,
  browserSupportsPasskeys,
  registerPasskey,
  listTrustedDevices,
  revokeTrustedDevice,
} from '../lib/mfa';
import { Loading } from './States';

function fmtDate(ts) {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return ts;
  }
}

export default function MfaSettings() {
  const [factors, setFactors] = useState(null);
  const [devices, setDevices] = useState([]);
  const [loadError, setLoadError] = useState(null);

  // TOTP enrollment state.
  const [enroll, setEnroll] = useState(null); // { factorId, qrSvg, secret }
  const [code, setCode] = useState('');
  // Email OTP enrollment state.
  const [emailEnroll, setEmailEnroll] = useState(null); // { factorId, email } | 'input'
  const [emailInput, setEmailInput] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);

  const reload = useCallback(async () => {
    setLoadError(null);
    try {
      const [f, d] = await Promise.all([listFactors(), listTrustedDevices().catch(() => [])]);
      setFactors(f);
      setDevices(d);
    } catch (err) {
      setLoadError(err?.message || 'Could not load your security settings.');
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (!factors && !loadError) return <Loading label="Loading security…" />;

  const verifiedTotp = (factors?.totp || []).filter((f) => f.status === 'verified');
  const verifiedEmail = (factors?.email || []).filter((f) => f.status === 'verified');
  const verifiedPasskeys = (factors?.webauthn || []).filter((f) => f.status === 'verified');

  // --- Email OTP actions ----------------------------------------------------

  const startEmailEnroll = () => {
    setError(null);
    setNotice(null);
    setEmailEnroll('input');
    setEmailInput('');
    setEmailCode('');
  };

  const cancelEmailEnroll = async () => {
    if (emailEnroll?.factorId) {
      try { await unenrollFactor(emailEnroll.factorId); } catch { /* best-effort */ }
    }
    setEmailEnroll(null);
    setEmailInput('');
    setEmailCode('');
    setError(null);
  };

  const sendEmailOtp = async (e) => {
    e.preventDefault();
    if (!emailInput.includes('@')) { setError('Enter a valid email address.'); return; }
    setError(null);
    setBusy(true);
    try {
      const result = await enrollEmail(emailInput);
      setEmailEnroll(result);
    } catch (err) {
      setError(err?.message || 'Could not send verification code.');
    } finally {
      setBusy(false);
    }
  };

  const confirmEmailEnroll = async (e) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(emailCode.replace(/\s/g, ''))) {
      setError('Enter the 6-digit code from your email.');
      return;
    }
    setBusy(true);
    try {
      await verifyFactor(emailEnroll.factorId, emailCode);
      setEmailEnroll(null);
      setEmailCode('');
      setNotice('Email OTP enabled. A code will be sent to your email at each sign-in.');
      await reload();
    } catch (err) {
      setError(err?.message || 'That code was not accepted. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  // --- TOTP actions ---------------------------------------------------------

  const startEnroll = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const result = await enrollTotp();
      setEnroll(result);
    } catch (err) {
      // The most common cause here is MFA being disabled in the Supabase
      // project, or a stale unverified factor from a prior attempt.
      setError(err?.message || 'Could not start enrollment.');
    } finally {
      setBusy(false);
    }
  };

  const cancelEnroll = async () => {
    // Drop the unverified factor so a retry starts clean.
    if (enroll?.factorId) {
      try {
        await unenrollFactor(enroll.factorId);
      } catch {
        /* best-effort cleanup */
      }
    }
    setEnroll(null);
    setCode('');
    setError(null);
  };

  const confirmEnroll = async (e) => {
    e.preventDefault();
    setError(null);
    if (!/^\d{6}$/.test(code.replace(/\s/g, ''))) {
      setError('Enter the 6-digit code from your authenticator app.');
      return;
    }
    setBusy(true);
    try {
      await verifyFactor(enroll.factorId, code);
      setEnroll(null);
      setCode('');
      setNotice('Authenticator app added. It will be required at your next sign-in.');
      await reload();
    } catch (err) {
      setError(err?.message || 'That code was not accepted. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const removeFactor = async (factorId, kind) => {
    if (!window.confirm(`Remove this ${kind}? You may be asked to set up MFA again.`)) {
      return;
    }
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await unenrollFactor(factorId);
      setNotice(`${kind} removed.`);
      await reload();
    } catch (err) {
      setError(err?.message || `Could not remove the ${kind}.`);
    } finally {
      setBusy(false);
    }
  };

  // --- Passkey actions ------------------------------------------------------

  const addPasskey = async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      await registerPasskey();
      setNotice('Passkey added.');
      await reload();
    } catch (err) {
      setError(
        err?.message ||
          'Could not add a passkey. Your browser or account may not support it yet.'
      );
    } finally {
      setBusy(false);
    }
  };

  // --- Trusted device actions ----------------------------------------------

  const revokeDevice = async (id) => {
    if (!window.confirm('Revoke trust for this device? It will need MFA next sign-in.')) {
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await revokeTrustedDevice(id);
      setDevices((d) => d.filter((x) => x.id !== id));
    } catch (err) {
      setError(err?.message || 'Could not revoke the device.');
    } finally {
      setBusy(false);
    }
  };

  // Passkeys: enrollment is wired to Supabase WebAuthn factors. If the browser
  // (or the supabase-js build) cannot do WebAuthn, show a "coming soon" state
  // instead. The Supabase project must also have the WebAuthn factor enabled;
  // if it is not, registerPasskey() surfaces that as an error in the UI.
  // TODO: once WebAuthn factors are confirmed enabled on the Supabase project,
  // also offer "Use a passkey" as a primary sign-in method on the Login screen.
  const passkeysSupported = browserSupportsPasskeys();

  return (
    <div className="card card-pad">
      <div className="section-title">Security &amp; multi-factor authentication</div>
      <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
        Add a second step at sign-in so a stolen password alone can't reach your
        account.
      </p>

      {loadError && <div className="alert alert-error">{loadError}</div>}
      {error && <div className="alert alert-error">{error}</div>}
      {notice && <div className="alert alert-success">{notice}</div>}

      {/* --- Email OTP --- */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Email verification code</div>

        {verifiedEmail.length > 0 && (
          <ul className="mfa-list">
            {verifiedEmail.map((f) => (
              <li key={f.id} className="mfa-row">
                <div>
                  <div style={{ fontWeight: 600 }}>{f.friendly_name || f.email || 'Email OTP'}</div>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>Added {fmtDate(f.created_at)}</div>
                </div>
                <button type="button" className="btn btn-danger btn-sm" disabled={busy}
                  onClick={() => removeFactor(f.id, 'email OTP')}>Remove</button>
              </li>
            ))}
          </ul>
        )}

        {emailEnroll === 'input' ? (
          <form onSubmit={sendEmailOtp} className="row-gap" style={{ marginTop: 8 }}>
            <input type="email" value={emailInput} onChange={(e) => setEmailInput(e.target.value)}
              placeholder="your@email.com" style={{ maxWidth: 240 }} />
            <button className="btn btn-primary" disabled={busy} type="submit">
              {busy ? 'Sending…' : 'Send code'}
            </button>
            <button type="button" className="btn btn-secondary" disabled={busy} onClick={cancelEmailEnroll}>Cancel</button>
          </form>
        ) : emailEnroll?.factorId ? (
          <div className="mfa-enroll">
            <p className="muted" style={{ fontSize: '0.84rem' }}>
              A 6-digit code was sent to <strong>{emailEnroll.email}</strong>. Enter it below to confirm.
            </p>
            <form onSubmit={confirmEmailEnroll} className="row-gap" style={{ marginTop: 8 }}>
              <input type="text" inputMode="numeric" maxLength={7} value={emailCode}
                onChange={(e) => setEmailCode(e.target.value)} placeholder="123456" style={{ maxWidth: 130 }} />
              <button className="btn btn-primary" disabled={busy} type="submit">
                {busy ? 'Verifying…' : 'Verify & enable'}
              </button>
              <button type="button" className="btn btn-secondary" disabled={busy} onClick={cancelEmailEnroll}>Cancel</button>
            </form>
          </div>
        ) : (
          <>
            <p className="muted" style={{ fontSize: '0.84rem' }}>
              Receive a one-time code by email each time you sign in.
            </p>
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={startEmailEnroll}>
              {verifiedEmail.length > 0 ? 'Add another email' : 'Set up email OTP'}
            </button>
          </>
        )}
      </div>

      {/* --- Authenticator app (TOTP) --- */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Authenticator app</div>

        {verifiedTotp.length > 0 && (
          <ul className="mfa-list">
            {verifiedTotp.map((f) => (
              <li key={f.id} className="mfa-row">
                <div>
                  <div style={{ fontWeight: 600 }}>
                    {f.friendly_name || 'Authenticator app'}
                  </div>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>
                    Added {fmtDate(f.created_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={() => removeFactor(f.id, 'authenticator app')}
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}

        {enroll ? (
          <div className="mfa-enroll">
            <p className="muted" style={{ fontSize: '0.84rem' }}>
              Scan this QR code with Google Authenticator, 1Password, Authy, or a
              similar app — then enter the 6-digit code it shows.
            </p>
            {enroll.qrSvg && (
              <img
                src={enroll.qrSvg}
                alt="Authenticator QR code"
                width={180}
                height={180}
                style={{ display: 'block', margin: '8px 0' }}
              />
            )}
            <p style={{ fontSize: '0.82rem' }}>
              Can't scan? Enter this key manually:
              <br />
              <code className="mono">{enroll.secret}</code>
            </p>
            <form onSubmit={confirmEnroll} className="row-gap" style={{ marginTop: 8 }}>
              <input
                type="text"
                inputMode="numeric"
                maxLength={7}
                value={code}
                onChange={(e) => setCode(e.target.value)}
                placeholder="123456"
                style={{ maxWidth: 130 }}
              />
              <button className="btn btn-primary" disabled={busy} type="submit">
                {busy ? 'Verifying…' : 'Verify & enable'}
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                disabled={busy}
                onClick={cancelEnroll}
              >
                Cancel
              </button>
            </form>
          </div>
        ) : (
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            disabled={busy}
            onClick={startEnroll}
          >
            {verifiedTotp.length > 0 ? 'Add another authenticator' : 'Set up authenticator app'}
          </button>
        )}
      </div>

      {/* --- Passkeys --- */}
      <div style={{ marginBottom: 18 }}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Passkeys</div>
        {passkeysSupported ? (
          <>
            {verifiedPasskeys.length > 0 && (
              <ul className="mfa-list">
                {verifiedPasskeys.map((f) => (
                  <li key={f.id} className="mfa-row">
                    <div>
                      <div style={{ fontWeight: 600 }}>
                        {f.friendly_name || 'Passkey'}
                      </div>
                      <div className="muted" style={{ fontSize: '0.8rem' }}>
                        Added {fmtDate(f.created_at)}
                      </div>
                    </div>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={busy}
                      onClick={() => removeFactor(f.id, 'passkey')}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted" style={{ fontSize: '0.84rem' }}>
              Use Touch ID, Windows Hello, or a security key as your second step.
            </p>
            <button
              type="button"
              className="btn btn-secondary btn-sm"
              disabled={busy}
              onClick={addPasskey}
            >
              Add a passkey
            </button>
          </>
        ) : (
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            Passkey support is coming soon — this browser can't register one yet.
          </p>
        )}
      </div>

      {/* --- Trusted devices --- */}
      <div>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>Trusted devices</div>
        <p className="muted" style={{ fontSize: '0.84rem' }}>
          Browsers where you chose "trust this device" skip the MFA step for 30
          days. Revoke any you don't recognize.
        </p>
        {devices.length === 0 ? (
          <p className="muted" style={{ fontSize: '0.84rem' }}>
            No trusted devices.
          </p>
        ) : (
          <ul className="mfa-list">
            {devices.map((d) => (
              <li key={d.id} className="mfa-row">
                <div>
                  <div style={{ fontWeight: 600 }}>{d.label || 'Trusted device'}</div>
                  <div className="muted" style={{ fontSize: '0.8rem' }}>
                    Last used {fmtDate(d.last_seen_at)} · Expires {fmtDate(d.expires_at)}
                  </div>
                </div>
                <button
                  type="button"
                  className="btn btn-danger btn-sm"
                  disabled={busy}
                  onClick={() => revokeDevice(d.id)}
                >
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
