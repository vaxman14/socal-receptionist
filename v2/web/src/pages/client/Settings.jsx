// Client Settings — edit business config (PATCH /admin/tenant).
// Three sections: Business profile, Voice Receptionist, AI.

import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { supabase } from '../../lib/supabase';
import { useFetch } from '../../lib/useFetch';
import { SMS_ENABLED } from '../../lib/config';
import { Loading, ErrorState } from '../../components/States';
import MfaSettings from '../../components/MfaSettings';
import { useAuth } from '../../context/AuthContext';

const VOICE_OPTIONS = [
  { id: 'Polly.Joanna-Neural',  label: 'Joanna',  desc: 'US English · Female · Warm & professional' },
  { id: 'Polly.Ruth-Neural',    label: 'Ruth',    desc: 'US English · Female · Natural & clear' },
  { id: 'Polly.Kendra-Neural',  label: 'Kendra',  desc: 'US English · Female · Friendly' },
  { id: 'Polly.Salli-Neural',   label: 'Salli',   desc: 'US English · Female · Upbeat' },
  { id: 'Polly.Matthew-Neural', label: 'Matthew', desc: 'US English · Male · Authoritative' },
  { id: 'Polly.Stephen-Neural', label: 'Stephen', desc: 'US English · Male · Conversational' },
  { id: 'Polly.Amy-Neural',     label: 'Amy',     desc: 'British English · Female · Premium' },
  { id: 'Polly.Brian-Neural',   label: 'Brian',   desc: 'British English · Male · Trustworthy' },
];

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
  'voice_id',
  'staff_phone',
  'voice_greeting',
  'voicemail_email',
];

export default function Settings() {
  const { user } = useAuth();
  const { data, loading, error, reload } = useFetch('/admin/me');
  const [form, setForm] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [previewState, setPreviewState] = useState('idle'); // idle | loading | playing
  const audioRef = useRef(null);
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

  const playPreview = async () => {
    if (previewState === 'loading') return;
    if (audioRef.current) { audioRef.current.pause(); audioRef.current = null; }
    setPreviewState('loading');
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token || '';
      const base = (import.meta.env.VITE_API_BASE || '').replace(/\/+$/, '');
      const res = await fetch(`${base}/admin/voice-preview/${encodeURIComponent(form.voice_id)}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) throw new Error('preview failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      audio.onended = () => { setPreviewState('idle'); URL.revokeObjectURL(url); };
      audio.onerror = () => setPreviewState('idle');
      await audio.play();
      setPreviewState('playing');
    } catch {
      setPreviewState('idle');
    }
  };

  useEffect(() => {
    if (data?.tenant) {
      const t = data.tenant;
      const next = {};
      for (const f of FIELDS) {
        if (f === 'voice_enabled') next[f] = Boolean(t[f]);
        else if (f === 'voice_id') next[f] = t[f] || 'Polly.Joanna-Neural';
        else next[f] = t[f] ?? '';
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
      if (f === 'voice_enabled') body[f] = form[f];
      else if (f === 'voice_id') body[f] = form[f] || 'Polly.Joanna-Neural';
      else body[f] = String(form[f]).trim() || null;
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

          <div className="field">
            <span className="label">Receptionist voice</span>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select style={{ flex: 1 }} value={form.voice_id} onChange={set('voice_id')}>
                {VOICE_OPTIONS.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label} — {v.desc}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-secondary"
                style={{ whiteSpace: 'nowrap', minWidth: 80 }}
                onClick={playPreview}
                disabled={previewState === 'loading'}
              >
                {previewState === 'loading' ? 'Loading…' : previewState === 'playing' ? '▶ Playing' : '▶ Preview'}
              </button>
            </div>
            <span className="hint">The voice your callers will hear. Preview uses a similar AI voice — not exact, but close.</span>
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

      {/* Email verification */}
      <div className="stack" style={{ marginTop: 16 }}>
        <div className="card card-pad">
          <div className="section-title">Email verification</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
            {emailConfirmed
              ? `Your email (${user?.email}) is verified.`
              : `Your email (${user?.email}) is not yet verified.`}
          </p>
          {!emailConfirmed && (
            <>
              {verifyMsg && (
                <div className="alert alert-success" style={{ marginBottom: 10 }}>{verifyMsg}</div>
              )}
              <button
                type="button"
                className="btn btn-secondary"
                disabled={verifyBusy}
                onClick={resendVerification}
              >
                {verifyBusy ? 'Sending…' : 'Send verification email'}
              </button>
            </>
          )}
          {emailConfirmed && (
            <span style={{ color: 'var(--green-dark)', fontWeight: 600, fontSize: '0.9rem' }}>✓ Verified</span>
          )}
        </div>
      </div>

      {/* Security / MFA — its own card; not part of the tenant config form
          above (factors live in Supabase Auth, not the tenants table). */}
      <div className="stack" style={{ marginTop: 16 }}>
        <MfaSettings />
      </div>
    </>
  );
}
