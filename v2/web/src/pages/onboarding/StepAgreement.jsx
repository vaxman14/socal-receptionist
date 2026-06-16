// Wizard step 2 — review + e-sign the Service Agreement via SignWell (embedded).
//   GET /onboarding/agreement              -> title/version + already_signed
//   GET /onboarding/agreement/sign-url     -> SignWell embedded signing URL
//   GET /onboarding/agreement/signwell-complete -> verify + record signature

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
  const [signUrl, setSignUrl] = useState(null);
  const [alreadySigned, setAlreadySigned] = useState(false);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState(null);

  const load = async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await api.get('/onboarding/agreement');
      setAgreement(data);
      if (data.already_signed) {
        setAlreadySigned(true);
      } else {
        const s = await api.get('/onboarding/agreement/sign-url');
        if (s.signed) setAlreadySigned(true);
        else setSignUrl(s.url);
      }
    } catch (err) {
      setLoadError(err.message || 'Could not load the agreement.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const checkSigned = async () => {
    setChecking(true);
    setError(null);
    try {
      const r = await api.get('/onboarding/agreement/signwell-complete');
      if (r.signed) onSigned({ provisioning_started: false });
      else setError("We haven't received your signed agreement yet. Finish signing above, then click again.");
    } catch (err) {
      setError(err.message || 'Could not verify your signature.');
    } finally {
      setChecking(false);
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
        {agreement.title} — version {agreement.version}. Review and sign below.
      </p>

      {alreadySigned ? (
        <div className="alert alert-success" style={{ marginTop: 18 }}>
          This agreement has already been signed for your business. You can continue.
          <div style={{ marginTop: 12 }}>
            <button className="btn btn-primary" onClick={() => onSigned({ already: true })}>
              Continue
            </button>
          </div>
        </div>
      ) : (
        <>
          <details style={{ marginBottom: 16 }}>
            <summary style={{ cursor: 'pointer', fontWeight: 600 }}>Read the full agreement</summary>
            <div style={{ marginTop: 12 }}>
              <Markdown source={agreement.text} />
            </div>
          </details>

          {signUrl ? (
            <iframe
              title="Sign Service Agreement"
              src={signUrl}
              style={{ width: '100%', height: 640, border: '1px solid #e5e7eb', borderRadius: 12 }}
              allow="camera"
            />
          ) : (
            <Loading label="Preparing your document…" />
          )}

          {error && <div className="alert alert-error" style={{ marginTop: 12 }}>{error}</div>}

          <div style={{ marginTop: 16 }}>
            <button className="btn btn-primary" disabled={checking || !signUrl} onClick={checkSigned}>
              {checking ? 'Checking…' : "I've signed — continue"}
            </button>
            <p className="hint" style={{ marginTop: 8 }}>
              Sign in the box above, then click to continue. Signing is powered by SignWell.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
