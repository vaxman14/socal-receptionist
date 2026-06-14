// Client Reminders — per-user proactive reminder settings.
//
// Each person (an attorney/agent, pulled from the connected calendar or added
// manually) maps to up to three reminder channels — phone call, PBX extension,
// and email — each independently toggled. Saved via PUT /admin/reminders;
// calendar users pulled via POST /admin/reminders/sync.

import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState } from '../../components/States';
import { Badge } from '../../components/Badge';

function blankRecipient() {
  return {
    name: '', match_email: '', source: 'manual', external_id: null,
    call_enabled: false, call_phone: '',
    ext_enabled: false, ext_value: '',
    email_enabled: false, email_address: '',
  };
}

const SOURCE_LABEL = { clio: 'Clio', google: 'Google', microsoft: 'Microsoft', manual: 'Manual' };

export default function Reminders() {
  const { data, loading, error, reload } = useFetch('/admin/reminders');
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    if (data?.recipients) {
      setList(data.recipients.map((r) => ({ ...blankRecipient(), ...r, match_email: r.match_email || '', call_phone: r.call_phone || '', ext_value: r.ext_value || '', email_address: r.email_address || '' })));
    }
  }, [data]);

  if (loading) return <Loading label="Loading reminders…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;
  if (!list) return <Loading />;

  const update = (i, patch) => {
    setList((l) => l.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
    setMsg(null);
  };
  const remove = (i) => { setList((l) => l.filter((_, idx) => idx !== i)); setMsg(null); };
  const addPerson = () => { setList((l) => [...l, blankRecipient()]); setMsg(null); };

  const sync = async () => {
    setSyncing(true);
    setMsg(null);
    try {
      const res = await api.post('/admin/reminders/sync', {});
      setList((res.recipients || []).map((r) => ({ ...blankRecipient(), ...r, match_email: r.match_email || '', call_phone: r.call_phone || '', ext_value: r.ext_value || '', email_address: r.email_address || '' })));
      setMsg({ ok: true, text: res.added ? `Added ${res.added} ${res.added === 1 ? 'person' : 'people'} from your calendar.` : 'Already up to date — no new people found.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Could not sync from your calendar.' });
    } finally {
      setSyncing(false);
    }
  };

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.put('/admin/reminders', { recipients: list });
      setList((res.recipients || []).map((r) => ({ ...blankRecipient(), ...r, match_email: r.match_email || '', call_phone: r.call_phone || '', ext_value: r.ext_value || '', email_address: r.email_address || '' })));
      setMsg({ ok: true, text: 'Reminder settings saved.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message || 'Could not save your reminder settings.' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Reminders</h1>
        <p>Set up proactive reminders per person. Each gets reminded for the events they own.</p>
      </div>

      {msg && <div className={`alert ${msg.ok ? 'alert-success' : 'alert-error'}`}>{msg.text}</div>}

      <div className="card card-pad" style={{ marginBottom: 16 }}>
        <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
          Pull your team from a connected calendar (Clio or Google), then choose how each
          person is reminded before their calendar events. Turn any channel on or off.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary" onClick={sync} disabled={syncing}>
            {syncing ? 'Syncing…' : 'Sync from calendar'}
          </button>
          <button type="button" className="btn btn-secondary" onClick={addPerson}>
            + Add person
          </button>
        </div>
      </div>

      {list.length === 0 ? (
        <div className="card card-pad">
          <p className="muted" style={{ margin: 0 }}>
            No reminder recipients yet. Sync from your calendar or add someone manually.
          </p>
        </div>
      ) : (
        <div className="stack">
          {list.map((r, i) => (
            <div className="card card-pad" key={r.id || `new-${i}`}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                    <input
                      type="text"
                      value={r.name}
                      onChange={(e) => update(i, { name: e.target.value })}
                      placeholder="Full name"
                      style={{ fontWeight: 600, flex: '1 1 200px' }}
                    />
                    <Badge color="gray">{SOURCE_LABEL[r.source] || 'Manual'}</Badge>
                  </div>
                  <label className="field" style={{ marginBottom: 0 }}>
                    <span className="label">Calendar email (matches their events)</span>
                    <input
                      type="email"
                      value={r.match_email}
                      onChange={(e) => update(i, { match_email: e.target.value })}
                      placeholder="attorney@firm.com"
                    />
                  </label>
                </div>
                <button
                  type="button"
                  onClick={() => remove(i)}
                  aria-label="Remove"
                  title="Remove"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--muted)', fontSize: '1.2rem', lineHeight: 1 }}
                >
                  ✕
                </button>
              </div>

              <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)', display: 'flex', flexDirection: 'column', gap: 10 }}>
                {/* Phone call */}
                <div>
                  <label className="checkbox">
                    <input type="checkbox" checked={r.call_enabled} onChange={(e) => update(i, { call_enabled: e.target.checked })} />
                    <span>Phone call reminder</span>
                  </label>
                  {r.call_enabled && (
                    <input
                      type="tel"
                      value={r.call_phone}
                      onChange={(e) => update(i, { call_phone: e.target.value })}
                      placeholder="+1 951 555 0142 (cell or landline)"
                      style={{ marginTop: 6 }}
                    />
                  )}
                </div>

                {/* Extension */}
                <div>
                  <label className="checkbox">
                    <input type="checkbox" checked={r.ext_enabled} onChange={(e) => update(i, { ext_enabled: e.target.checked })} />
                    <span>Extension reminder</span>
                  </label>
                  {r.ext_enabled && (
                    <>
                      <input
                        type="text"
                        value={r.ext_value}
                        onChange={(e) => update(i, { ext_value: e.target.value })}
                        placeholder="e.g. 101"
                        style={{ marginTop: 6 }}
                      />
                      <span className="hint">Requires a connected phone system (Asterisk / SIP). Falls back to phone call if none.</span>
                    </>
                  )}
                </div>

                {/* Email */}
                <div>
                  <label className="checkbox">
                    <input type="checkbox" checked={r.email_enabled} onChange={(e) => update(i, { email_enabled: e.target.checked })} />
                    <span>Email reminder</span>
                  </label>
                  {r.email_enabled && (
                    <input
                      type="email"
                      value={r.email_address}
                      onChange={(e) => update(i, { email_address: e.target.value })}
                      placeholder="attorney@firm.com"
                      style={{ marginTop: 6 }}
                    />
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="row-gap" style={{ marginTop: 16 }}>
        <button className="btn btn-primary" onClick={save} disabled={busy}>
          {busy ? 'Saving…' : 'Save changes'}
        </button>
      </div>
    </>
  );
}
