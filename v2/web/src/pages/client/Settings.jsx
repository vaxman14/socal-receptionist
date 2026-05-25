// Client Settings — edit business config (PATCH /admin/tenant).
// Three sections: Business profile, Voice Receptionist, AI.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { SMS_ENABLED } from '../../lib/config';
import { Loading, ErrorState } from '../../components/States';
import MfaSettings from '../../components/MfaSettings';

const TIMEZONES = [
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Phoenix',
  'America/Anchorage',
  'Pacific/Honolulu',
];

const FIELDS = [
  'business_name',
  'business_hours',
  'business_services',
  'calendly_link',
  'timezone',
  'ai_system_prompt',
  'voice_enabled',
  'staff_phone',
  'voice_greeting',
  'voicemail_email',
];

export default function Settings() {
  const { data, loading, error, reload } = useFetch('/admin/me');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (data?.tenant) {
      const t = data.tenant;
      const next = {};
      for (const f of FIELDS) {
        next[f] = f === 'voice_enabled' ? Boolean(t[f]) : t[f] ?? '';
      }
      setForm(next);
    }
  }, [data]);

  if (loading) return <Loading label="Loading settings…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!form) return <Loading />;

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  const submit = async (e) => {
    e.preventDefault();
    setSaveError(null);
    setSaved(false);

    if (!String(form.business_name).trim()) {
      setSaveError('Business name cannot be empty.');
      return;
    }
    if (form.voice_enabled && !String(form.staff_phone).trim()) {
      setSaveError('A staff transfer number is required while voice is enabled.');
      return;
    }

    // Send all editable fields; empty strings become null on the server side.
    const body = {};
    for (const f of FIELDS) {
      body[f] = f === 'voice_enabled' ? form[f] : String(form[f]).trim() || null;
    }

    setBusy(true);
    try {
      await api.patch('/admin/tenant', body);
      setSaved(true);
      reload();
    } catch (err) {
      setSaveError(err.message || 'Could not save your settings.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Settings</h1>
        <p>Configure how your AI receptionist handles calls.</p>
      </div>

      {saveError && <div className="alert alert-error">{saveError}</div>}
      {saved && <div className="alert alert-success">Settings saved.</div>}

      <form onSubmit={submit} className="stack">
        <div className="card card-pad">
          <div className="section-title">Business profile</div>

          <label className="field">
            <span className="label">Business name *</span>
            <input type="text" value={form.business_name} onChange={set('business_name')} />
          </label>
          <label className="field">
            <span className="label">Business hours</span>
            <input type="text" value={form.business_hours} onChange={set('business_hours')} />
          </label>
          <label className="field">
            <span className="label">Services offered</span>
            <textarea value={form.business_services} onChange={set('business_services')} />
          </label>
          <label className="field">
            <span className="label">Calendly / booking link</span>
            <input type="url" value={form.calendly_link} onChange={set('calendly_link')} />
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="label">Timezone</span>
            <select value={form.timezone || 'America/Los_Angeles'} onChange={set('timezone')}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="card card-pad">
          <div className="section-title">Voice Receptionist</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 8 }}>
            Controls how inbound phone calls are answered.
          </p>

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
            <input type="tel" value={form.staff_phone} onChange={set('staff_phone')} />
            <span className="hint">
              Where callers are transferred when they press 2 or ask for a person.
              Must <strong>not</strong> be your main published number.
            </span>
          </label>
          <label className="field">
            <span className="label">Voice greeting</span>
            <textarea value={form.voice_greeting} onChange={set('voice_greeting')} />
            <span className="hint">Leave blank for a generated default greeting.</span>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="label">Voicemail notification email</span>
            <input type="email" value={form.voicemail_email} onChange={set('voicemail_email')} />
            <span className="hint">
              Where missed-call and voicemail alerts are sent. Blank uses your
              account email.
            </span>
          </label>
        </div>

        <div className="card card-pad">
          <div className="section-title">AI</div>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="label">System prompt override</span>
            <textarea
              className="code"
              rows={8}
              value={form.ai_system_prompt}
              onChange={set('ai_system_prompt')}
              placeholder="Leave blank to use the default SoCal Receptionist prompt."
            />
            <span className="hint">
              Advanced: customize the receptionist's tone and instructions. Blank
              uses the platform default.
            </span>
          </label>
        </div>

        <div className="row-gap">
          <button className="btn btn-primary" disabled={busy} type="submit">
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          {saved && <span className="muted" style={{ fontSize: '0.86rem' }}>All changes saved.</span>}
        </div>
      </form>

      {/* Security / MFA — its own card; not part of the tenant config form
          above (factors live in Supabase Auth, not the tenants table). */}
      <div className="stack" style={{ marginTop: 16 }}>
        <MfaSettings />
      </div>
    </>
  );
}
