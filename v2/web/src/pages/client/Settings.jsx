// Client Settings — edit business config (PATCH /admin/tenant).
// Three sections: Business profile, Voice Receptionist, AI.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState } from '../../components/States';
import MfaSettings from '../../components/MfaSettings';
import BusinessHoursPicker from '../../components/BusinessHoursPicker';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase';

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
  'voice_id',
  'outbound_enabled',
  'outbound_reminder_phone',
  'outbound_caller_id',
];

const VOICE_OPTIONS = [
  { value: 'Polly.Joanna-Neural',  label: 'Joanna — US English, Female (Default)' },
  { value: 'Polly.Matthew-Neural', label: 'Matthew — US English, Male'             },
  { value: 'Polly.Salli-Neural',   label: 'Salli — US English, Female (Warm)'      },
  { value: 'Polly.Joey-Neural',    label: 'Joey — US English, Male (Friendly)'      },
  { value: 'Polly.Amy-Neural',     label: 'Amy — British English, Female'           },
  { value: 'Polly.Brian-Neural',   label: 'Brian — British English, Male'           },
];

const API_BASE = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
let previewAudio = null;

function previewVoice(voiceValue) {
  if (previewAudio) { previewAudio.pause(); }
  const url = `${API_BASE}/voice/preview?voice=${encodeURIComponent(voiceValue)}`;
  previewAudio = new Audio(url);
  previewAudio.play().catch(console.error);
}

export default function Settings() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useFetch('/admin/me');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyMsg, setVerifyMsg] = useState(null);

  const emailConfirmed = !!user?.email_confirmed_at;

  const resendVerification = async () => {
    setVerifyBusy(true);
    setVerifyMsg(null);
    try {
      const { error: err } = await supabase.auth.resend({ type: 'signup', email: user.email });
      if (err) throw err;
      setVerifyMsg('Confirmation email sent. Check your inbox.');
    } catch (err) {
      setVerifyMsg(err.message || 'Could not send confirmation email.');
    } finally {
      setVerifyBusy(false);
    }
  };

  useEffect(() => {
    if (data?.tenant) {
      const t = data.tenant;
      const next = {};
      const boolFields = new Set(['voice_enabled', 'outbound_enabled']);
      for (const f of FIELDS) {
        next[f] = boolFields.has(f) ? Boolean(t[f]) : t[f] ?? '';
      }
      if (!next.voice_id) next.voice_id = 'Polly.Joanna-Neural';
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
    const boolFields = new Set(['voice_enabled', 'outbound_enabled']);
    const body = {};
    for (const f of FIELDS) {
      body[f] = boolFields.has(f) ? form[f] : String(form[f]).trim() || null;
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

      {data?.phoneNumber && (
        <div className="card card-pad" style={{ marginBottom: 0 }}>
          <div className="section-title">Your Receptionist Number</div>
          <p style={{ fontSize: '1.5rem', fontWeight: 700, letterSpacing: '0.05em', margin: '8px 0 4px' }}>
            {data.phoneNumber.phone_e164}
          </p>
          <p className="muted" style={{ fontSize: '0.82rem' }}>
            {data.phoneNumber.is_byo
              ? 'Bring-your-own number — forwarded to this receptionist.'
              : 'This number was provisioned by SoCal Receptionist. Give it to your clients to call.'}
          </p>
        </div>
      )}

      {saveError && <div className="alert alert-error">{saveError}</div>}
      {saved && <div className="alert alert-success">Settings saved.</div>}

      <form onSubmit={submit} className="stack">
        <div className="card card-pad">
          <div className="section-title">Business profile</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
            This is what your AI receptionist knows about your business. The more detail you add, the better it answers callers.
          </p>

          <label className="field">
            <span className="label">Business name *</span>
            <input type="text" value={form.business_name} onChange={set('business_name')} placeholder="e.g. Temecula Valley Plumbing" />
            <span className="hint">The AI uses this name when greeting callers and introducing itself.</span>
          </label>
          <div className="field">
            <span className="label">Business hours</span>
            <BusinessHoursPicker
              value={form.business_hours}
              onChange={(val) => setForm((f) => ({ ...f, business_hours: val }))}
            />
            <span className="hint">The AI tells callers your hours and knows not to promise same-day service if you're closed.</span>
          </div>
          <label className="field">
            <span className="label">Services offered</span>
            <textarea
              value={form.business_services}
              onChange={set('business_services')}
              placeholder="e.g. Drain cleaning, water heater repair, leak detection, repiping, emergency plumbing"
            />
            <span className="hint">List your services so the AI can answer "do you do X?" questions accurately.</span>
          </label>
          <label className="field">
            <span className="label">Calendly / booking link</span>
            <input type="url" value={form.calendly_link} onChange={set('calendly_link')} placeholder="https://calendly.com/your-business" />
            <span className="hint">When a caller wants to book, the AI offers to send them this link via text.</span>
          </label>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="label">Timezone</span>
            <select value={form.timezone || 'America/Los_Angeles'} onChange={set('timezone')}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="card card-pad">
          <div className="section-title">Voice Receptionist</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 8 }}>
            Controls how inbound phone calls are handled.
          </p>

          <div className="toggle-row">
            <div>
              <div style={{ fontWeight: 600 }}>Answer phone calls</div>
              <div className="muted" style={{ fontSize: '0.82rem' }}>
                When enabled, the AI picks up every inbound call to your number automatically.
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
            <input type="tel" value={form.staff_phone} onChange={set('staff_phone')} placeholder="+1 951 555 0142" />
            <span className="hint">
              When a caller asks to speak to a person, the AI transfers them here. Use your personal cell or office line — <strong>not</strong> the receptionist number itself.
            </span>
          </label>
          <label className="field">
            <span className="label">Opening greeting</span>
            <textarea
              value={form.voice_greeting}
              onChange={set('voice_greeting')}
              placeholder={`e.g. "Thank you for calling ${form.business_name || 'us'}, how can I help you today?"`}
            />
            <span className="hint">
              The first thing callers hear. Leave blank and the AI will say <em>"Thank you for calling {form.business_name || 'your business'}, how can I help you today?"</em>
            </span>
          </label>
          <label className="field">
            <span className="label">Voicemail notification email</span>
            <input type="email" value={form.voicemail_email} onChange={set('voicemail_email')} placeholder="owner@yourbusiness.com" />
            <span className="hint">
              You'll get an email alert here whenever a caller leaves a voicemail or the AI captures a lead. Defaults to your account email if left blank.
            </span>
          </label>
          <div className="field" style={{ marginBottom: 0 }}>
            <span className="label">Receptionist voice</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select value={form.voice_id} onChange={set('voice_id')} style={{ flex: 1 }}>
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.value} value={v.value}>{v.label}</option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ whiteSpace: 'nowrap', padding: '0 14px', height: 38 }}
                onClick={() => previewVoice(form.voice_id)}
              >
                ▶ Preview
              </button>
            </div>
            <span className="hint">Click Preview to hear a sample before saving.</span>
          </div>
        </div>

        <div className="card card-pad">
          <div className="section-title">Outbound Call Assist</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 8 }}>
            Dial any contact by voice — "Hey, get Robert on the phone" — and bridge the call instantly.
            Also reminds you before calendar events.
          </p>

          <div className="toggle-row">
            <div>
              <div style={{ fontWeight: 600 }}>Enable Outbound Call Assist</div>
              <div className="muted" style={{ fontSize: '0.82rem' }}>
                Lets you ask the AI to dial contacts and receive proactive calendar reminders.
              </div>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={form.outbound_enabled}
                onChange={set('outbound_enabled')}
              />
              <span>Enabled</span>
            </label>
          </div>

          <label className="field">
            <span className="label">
              Reminder phone number {form.outbound_enabled ? '*' : ''}
            </span>
            <input
              type="tel"
              value={form.outbound_reminder_phone}
              onChange={set('outbound_reminder_phone')}
              placeholder="+1 555 000 0000"
            />
            <span className="hint">
              The AI will call this number 5 minutes before calendar events to remind you and offer to connect your contact.
            </span>
          </label>

          <label className="field" style={{ marginBottom: 0 }}>
            <span className="label">Outbound caller ID</span>
            <input
              type="tel"
              value={form.outbound_caller_id}
              onChange={set('outbound_caller_id')}
              placeholder="+1 555 000 0000"
            />
            <span className="hint">
              The number that appears when the AI dials on your behalf. Defaults to your main receptionist number.
              Must be a Twilio-verified number.
            </span>
          </label>
        </div>

        <div className="card card-pad">
          <div className="section-title">AI</div>
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="label">Custom AI instructions</span>
            <textarea
              className="code"
              rows={8}
              value={form.ai_system_prompt}
              onChange={set('ai_system_prompt')}
              placeholder="Leave blank to use the default SoCal Receptionist behavior. Only change this if you need custom tone, specific scripts, or special instructions for your industry."
            />
            <span className="hint">
              Override how the AI behaves entirely. For most businesses, leave this blank.
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

        {!emailConfirmed && (
          <div className="card card-pad">
            <div className="section-title">Email Verification</div>
            <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
              Your email address <strong>{user?.email}</strong> has not been verified yet. Verify it to unlock billing and subscription features.
            </p>
            {verifyMsg && (
              <div className={`alert ${verifyMsg.startsWith('Confirmation') ? 'alert-success' : 'alert-error'}`} style={{ marginBottom: 12 }}>
                {verifyMsg}
              </div>
            )}
            <button className="btn btn-secondary" onClick={resendVerification} disabled={verifyBusy}>
              {verifyBusy ? 'Sending…' : 'Resend verification email'}
            </button>
          </div>
        )}
      </div>
    </>
  );
}
