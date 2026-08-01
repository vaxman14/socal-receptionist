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
  const [name, setName] = useState('');
  const [title, setTitle] = useState('Owner');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    setLoadError(null);
    try { setAgreement(await api.get('/onboarding/agreement')); }
    catch (err) { setLoadError(err.message || 'Could not load the agreement.'); }
    finally { setLoading(false); }
  }

  useEffect(() => { load(); }, []);

  async function sign(event) {
    event.preventDefault();
    setError(null);
    if (!name.trim()) return setError('Enter your full legal name.');
    if (!consent) return setError('You must consent to sign electronically.');
    setBusy(true);
    try {
      const result = await api.post('/onboarding/agreement/sign', {
        signer_name: name.trim(),
        signer_title: title.trim() || 'Owner',
        signer_email: user?.email,
        esign_consent: true,
        acknowledged_version: agreement.version,
      });
      onSigned(result);
    } catch (err) {
      setError(err.message || 'Could not record your signature.');
    } finally { setBusy(false); }
  }

  if (loading) return <div className="card card-pad"><Loading label="Loading your agreement…" /></div>;
  if (loadError) return <div className="card card-pad"><ErrorState message={loadError} onRetry={load} /></div>;
  if (agreement.already_signed) return (
    <div className="card card-pad">
      <h1>Service Agreement</h1>
      <div className="alert alert-success">Your current agreement is already signed.</div>
      <button className="btn btn-primary" onClick={() => onSigned({ already: true })}>Continue →</button>
    </div>
  );

  return (
    <div className="card card-pad">
      <h1>Review and sign</h1>
      <p className="muted">{agreement.title} · version {agreement.version}</p>
      <div style={{ maxHeight: 430, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 10, padding: 18, margin: '16px 0' }}>
        <Markdown source={agreement.text} />
      </div>
      <form onSubmit={sign}>
        {error && <div className="alert alert-error">{error}</div>}
        <label className="field"><span className="label">Full legal name *</span><input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>
        <label className="field"><span className="label">Title</span><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Owner" /></label>
        <label className="checkbox" style={{ alignItems: 'flex-start', margin: '16px 0' }}>
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
          <span>{agreement.esign_consent}</span>
        </label>
        <button className="btn btn-primary btn-block" disabled={busy} type="submit">{busy ? 'Signing…' : 'Sign & continue →'}</button>
      </form>
    </div>
  );
}
