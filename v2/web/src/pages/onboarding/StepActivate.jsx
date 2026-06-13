// Onboarding Step — "Activate your receptionist" (after the Service Agreement).
// Two paths:
//   • Get a SoCal number  -> self-serve: starts a 7-day no-card trial + provisions
//   • Bring your own phone -> Concierge white-glove setup (sales-assisted handoff)
import { useState } from 'react';
import { api } from '../../lib/api';

export default function StepActivate({ onActivated }) {
  const [busy, setBusy] = useState('');      // '' | 'socal_number' | 'byo_sip'
  const [error, setError] = useState('');
  const [handoff, setHandoff] = useState(null); // byo_sip confirmation message

  async function activate(method) {
    setError('');
    setBusy(method);
    try {
      const res = await api.post('/onboarding/activate', { method });
      if (method === 'socal_number') {
        onActivated(res); // trial started + number provisioning; advance the wizard
      } else {
        setHandoff(res?.message || 'Our team will reach out to set up your phone system.');
      }
    } catch (e) {
      setError(e?.message || 'Something went wrong. Please try again.');
    } finally {
      setBusy('');
    }
  }

  if (handoff) {
    return (
      <div className="card">
        <h2>Thanks — we’ll take it from here</h2>
        <p>{handoff}</p>
        <p className="muted">
          You don’t need a SoCal number — our Concierge team will integrate your existing
          phone system and reach out shortly to finish setup.
        </p>
        <button className="btn btn-primary" onClick={() => onActivated({ method: 'byo_sip', handoff: true })}>
          Continue
        </button>
      </div>
    );
  }

  return (
    <div className="card">
      <h2>Activate your receptionist</h2>
      <p className="muted">
        You’re signed and ready. Pick how you want your AI receptionist to take calls.
        Your <strong>7-day free trial</strong> starts now — no credit card required.
      </p>

      {error && <div className="banner banner-danger">{error}</div>}

      <div className="activate-grid">
        {/* Self-serve: SoCal number */}
        <div className="activate-option">
          <h3>Get a SoCal number</h3>
          <p>
            We’ll provision a local phone number and put your AI receptionist live in a
            couple of minutes. Best if you don’t have a business line yet.
          </p>
          <ul className="muted">
            <li>New local number, ready instantly</li>
            <li>Voice + (SMS coming soon)</li>
            <li>7-day free trial, cancel anytime</li>
          </ul>
          <button
            className="btn btn-primary"
            disabled={!!busy}
            onClick={() => activate('socal_number')}
          >
            {busy === 'socal_number' ? 'Starting your trial…' : 'Start free trial & get a number'}
          </button>
        </div>

        {/* Concierge: bring your own phone system */}
        <div className="activate-option activate-concierge">
          <div className="pill">Concierge</div>
          <h3>Bring your own phone system</h3>
          <p>
            Already have a phone system or SIP trunk (RingCentral, Vonage, Telnyx, or an
            on-prem PBX)? Our team integrates it for you as part of white-glove setup.
          </p>
          <ul className="muted">
            <li>Keep your existing number &amp; carrier</li>
            <li>We wire your SIP trunk / PBX</li>
            <li>Includes a one-time setup fee</li>
          </ul>
          <button
            className="btn btn-ghost"
            disabled={!!busy}
            onClick={() => activate('byo_sip')}
          >
            {busy === 'byo_sip' ? 'Submitting…' : 'Talk to us about Concierge setup'}
          </button>
        </div>
      </div>
    </div>
  );
}
