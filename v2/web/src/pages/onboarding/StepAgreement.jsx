// Wizard step 2 — render + e-sign the Service Agreement.
//   GET  /onboarding/agreement
//   POST /onboarding/agreement/sign

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useAuth } from '../../context/AuthContext';
import { Markdown } from '../../components/Markdown';
import { Loading, ErrorState } from '../../components/States';

export default function StepAgreement({ onSigned }) {
  const { user } = useAuth();
  const [agreement, setAgreement] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);

  const [signerName, setSignerName] = useState('');
  const [signerTitle, setSignerTitle] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get('/onboarding/agreement');
      setAgreement(data);
    } catch (err) {
      setLoadError(err.message || 'Could not load the agreement.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!signerName.trim()) {
      setError('Type your full legal name to sign.');
      return;
    }
    if (!consent) {
      setError('You must agree to sign electronically.');
      return;
    }

    setBusy(true);
    try {
      const result = await api.post('/onboarding/agreement/sign', {
        signer_name: signerName.trim(),
        signer_title: signerTitle.trim() || undefined,
        signer_email: user?.email,
        esign_consent: true,
        acknowledged_version: agreement.version,
      });
      onSigned(result);
    } catch (err) {
      setError(err.message || 'Could not record your signature.');
      // A version-changed conflict means the contract was updated — reload it.
      if (/version/i.test(err.message || '')) load();
    } finally {
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="card card-pad">
        <Loading label="Loading your agreement…" />
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="card card-pad">
        <ErrorState message={loadError} onRetry={load} />
      </div>
    );
  }

  return (
    <div className="card card-pad">
      <h1>Sign your Service Agreement</h1>
      <p className="muted" style={{ marginBottom: 16, fontSize: '0.92rem' }}>
        {agreement.title} — version {agreement.version}. Provisioning of your
        phone number begins as soon as this is signed.
      </p>

      <Markdown source={agreement.text} />

      {agreement.already_signed ? (
        <div className="alert alert-success" style={{ marginTop: 18 }}>
          This agreement has already been signed for your business. You can
          continue to your dashboard.
          <div style={{ marginTop: 12 }}>
            <button
              className="btn btn-primary"
              onClick={() => onSigned({ provisioning_started: false, already: true })}
            >
              Continue
            </button>
          </div>
        </div>
      ) : (
        <>
          <div className="disclosure">
            <strong>Electronic signature consent.</strong>
            <div style={{ marginTop: 6, whiteSpace: 'pre-wrap' }}>
              {agreement.esign_consent}
            </div>
          </div>

          {error && <div className="alert alert-error">{error}</div>}

          <form onSubmit={submit}>
            <label className="field">
              <span className="label">Full legal name *</span>
              <input
                type="text"
                value={signerName}
                onChange={(e) => setSignerName(e.target.value)}
                placeholder="Jordan A. Rivera"
              />
              <span className="hint">
                Typing your name here is your electronic signature.
              </span>
            </label>

            <label className="field">
              <span className="label">Title (optional)</span>
              <input
                type="text"
                value={signerTitle}
                onChange={(e) => setSignerTitle(e.target.value)}
                placeholder="Owner"
              />
            </label>

            <label className="field">
              <span className="label">Signing as</span>
              <input type="email" value={user?.email || ''} disabled />
            </label>

            <label className="checkbox" style={{ marginBottom: 16 }}>
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
              />
              <span>
                I agree to sign this Service Agreement electronically, and I have
                the authority to bind my business to it.
              </span>
            </label>

            <button className="btn btn-primary" disabled={busy} type="submit">
              {busy ? 'Signing…' : 'Sign & start provisioning'}
            </button>
          </form>
        </>
      )}
    </div>
  );
}
