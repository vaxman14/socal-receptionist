import { useState } from 'react';
import { api } from '../../lib/api';

export default function StepActivate({ onActivated }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function activate() {
    setError('');
    setBusy(true);
    try {
      const result = await api.post('/onboarding/activate', { method: 'socal_number' });
      onActivated(result);
    } catch (err) {
      setError(err?.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card card-pad">
      <h2>Activate your receptionist</h2>
      <p className="muted">
        We’ll provision your business number and put your AI receptionist live. Your <strong>30-day free trial</strong> starts now, with no credit card required.
      </p>
      {error && <div className="alert alert-error">{error}</div>}
      <ul className="muted" style={{ margin: '18px 0' }}>
        <li>Dedicated local business number</li>
        <li>AI call answering and lead capture</li>
        <li>Lead summaries emailed to your chosen address</li>
        <li>Optional Google or Microsoft calendar booking</li>
      </ul>
      <button className="btn btn-primary btn-block" disabled={busy} onClick={activate}>
        {busy ? 'Starting your trial…' : 'Start my 30-day free trial →'}
      </button>
    </div>
  );
}
