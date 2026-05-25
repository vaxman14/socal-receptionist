// Wizard step 1 — business profile form. POST /onboarding/business.

import { useState } from 'react';
import { api } from '../../lib/api';
import { SMS_ENABLED } from '../../lib/config';

const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
];

export default function StepBusiness({ onCreated }) {
  const [form, setForm] = useState({
    business_name: '',
    business_hours: '',
    business_services: '',
    calendly_link: '',
    timezone: 'America/Los_Angeles',
    voice_enabled: true,
    staff_phone: '',
    voice_greeting: '',
    voicemail_email: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!form.business_name.trim()) {
      setError('Business name is required.');
      return;
    }
    if (form.voice_enabled && !form.staff_phone.trim()) {
      setError(
        'A staff transfer number is required when the voice receptionist is on.'
      );
      return;
    }

    // Send only non-empty optional fields.
    const body = { business_name: form.business_name.trim(), voice_enabled: form.voice_enabled };
    for (const k of [
      'business_hours',
      'business_services',
      'calendly_link',
      'timezone',
      'staff_phone',
      'voice_greeting',
      'voicemail_email',
    ]) {
      if (String(form[k]).trim()) body[k] = String(form[k]).trim();
    }

    setBusy(true);
    try {
      const data = await api.post('/onboarding/business', body);
      onCreated(data.tenant);
    } catch (err) {
      setError(err.message || 'Could not create your business.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad">
      <h1>Tell us about your business</h1>
      <p className="muted" style={{ marginBottom: 18, fontSize: '0.92rem' }}>
        This configures how your AI receptionist answers{' '}
        {SMS_ENABLED ? 'texts and calls' : 'calls'}. You can change everything
        later in Settings.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={submit}>
        <label className="field">
          <span className="label">Business name *</span>
          <input
            type="text"
            name="organization"
            autoComplete="organization"
            value={form.business_name}
            onChange={set('business_name')}
            placeholder="Temecula Valley Plumbing"
          />
        </label>

        <label className="field">
          <span className="label">Business hours</span>
          <input
            type="text"
            name="business_hours"
            autoComplete="off"
            value={form.business_hours}
            onChange={set('business_hours')}
            placeholder="Mon–Fri 8am–5pm, Sat 9am–1pm"
          />
        </label>

        <label className="field">
          <span className="label">Services offered</span>
          <textarea
            value={form.business_services}
            onChange={set('business_services')}
            placeholder="Drain cleaning, water heater repair, leak detection, repiping…"
          />
        </label>

        <label className="field">
          <span className="label">Calendly / booking link</span>
          <input
            type="url"
            name="calendly_link"
            autoComplete="url"
            value={form.calendly_link}
            onChange={set('calendly_link')}
            placeholder="https://calendly.com/your-business"
          />
          <span className="hint">
            If provided, the AI shares this link when a customer wants to book.
          </span>
        </label>

        <label className="field">
          <span className="label">Timezone</span>
          <select value={form.timezone} onChange={set('timezone')}>
            {TIMEZONES.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>

        <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '20px 0 14px' }} />
        <div className="section-title">Voice Receptionist</div>

        <div className="toggle-row">
          <div>
            <div style={{ fontWeight: 600 }}>Answer phone calls</div>
            <div className="muted" style={{ fontSize: '0.82rem' }}>
              Let the AI receptionist pick up calls to your number.
            </div>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={form.voice_enabled}
              onChange={set('voice_enabled')}
            />
            <span>Enabled</span>
          </label>
        </div>

        <label className="field">
          <span className="label">
            Staff transfer number {form.voice_enabled ? '*' : ''}
          </span>
          <input
            type="tel"
            name="tel"
            autoComplete="tel"
            value={form.staff_phone}
            onChange={set('staff_phone')}
            placeholder="+1 951 555 0142"
          />
          <span className="hint">
            The number we transfer callers to when they press 2 or ask for a
            person. This must <strong>not</strong> be your main published number —
            that would loop the call back to the receptionist.
          </span>
        </label>

        <label className="field">
          <span className="label">Voice greeting (optional)</span>
          <textarea
            value={form.voice_greeting}
            onChange={set('voice_greeting')}
            placeholder="Thanks for calling Temecula Valley Plumbing. How can I help you today?"
          />
          <span className="hint">Leave blank to use a generated default greeting.</span>
        </label>

        <label className="field">
          <span className="label">Voicemail notification email</span>
          <input
            type="email"
            name="email"
            autoComplete="email"
            value={form.voicemail_email}
            onChange={set('voicemail_email')}
            placeholder="owner@business.com"
          />
          <span className="hint">
            Where missed-call and voicemail alerts are sent. Defaults to your
            account email.
          </span>
        </label>

        <button className="btn btn-primary" disabled={busy} type="submit">
          {busy ? 'Saving…' : 'Continue to agreement'}
        </button>
      </form>
    </div>
  );
}
