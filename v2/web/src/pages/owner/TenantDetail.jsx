// Owner Tenant Detail — one tenant: profile, voice, billing, usage, numbers.
// GET /admin/owner/tenants/:id  ->  { tenant: { ...tenant, subscriptions, phone_numbers } }

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState } from '../../components/States';
import { Badge } from '../../components/Badge';
import { formatDate, formatDateShort } from '../../lib/format';

// Spend caps + usage counters are stored in cents.
function usd(cents) {
  if (cents === null || cents === undefined) return '—';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

export default function TenantDetail() {
  const { id } = useParams();
  const { data, loading, error, reload } = useFetch(`/admin/owner/tenants/${id}`);
  const [prompt, setPrompt] = useState(null);
  const [promptBusy, setPromptBusy] = useState(false);
  const [promptSaved, setPromptSaved] = useState(false);
  const [promptError, setPromptError] = useState(null);

  if (loading) return <Loading label="Loading tenant…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const t = data?.tenant;
  if (!t) return <ErrorState message="Tenant not found." />;

  const currentPrompt = prompt !== null ? prompt : (t.ai_system_prompt || '');

  const savePrompt = async () => {
    setPromptBusy(true);
    setPromptError(null);
    setPromptSaved(false);
    try {
      await api.patch(`/admin/owner/tenants/${id}`, { ai_system_prompt: currentPrompt });
      setPromptSaved(true);
      reload();
    } catch (err) {
      setPromptError(err.message || 'Save failed.');
    } finally {
      setPromptBusy(false);
    }
  };

  const sub = Array.isArray(t.subscriptions) ? t.subscriptions[0] : t.subscriptions;
  const numbers = t.phone_numbers || [];

  return (
    <>
      <div className="page-head">
        <Link to="/tenants" className="muted" style={{ fontSize: '0.85rem' }}>
          ← Back to tenants
        </Link>
        <h1 style={{ marginTop: 6 }}>{t.business_name}</h1>
        <p className="row-gap">
          <span className="mono">{t.slug}</span>
          <Badge value={t.status} />
        </p>
      </div>

      <div className="stack">
        <div className="card card-pad">
          <div className="section-title">Business profile</div>
          <dl className="kv">
            <dt>Owner email</dt>
            <dd>{t.owner_email || '—'}</dd>
            <dt>Timezone</dt>
            <dd>{t.timezone || '—'}</dd>
            <dt>Business hours</dt>
            <dd>{t.business_hours || '—'}</dd>
            <dt>Services</dt>
            <dd>{t.business_services || '—'}</dd>
            <dt>Booking link</dt>
            <dd>
              {t.calendly_link ? (
                <a href={t.calendly_link} target="_blank" rel="noopener noreferrer">
                  {t.calendly_link}
                </a>
              ) : (
                '—'
              )}
            </dd>
            <dt>AI model</dt>
            <dd>{t.ai_model || '—'}</dd>
            <dt>Created</dt>
            <dd>{formatDate(t.created_at)}</dd>
            <dt>Activated</dt>
            <dd>{t.activated_at ? formatDate(t.activated_at) : '—'}</dd>
          </dl>
        </div>

        <div className="card card-pad">
          <div className="section-title">AI system prompt</div>
          <p className="muted" style={{ fontSize: '0.86rem', marginBottom: 12 }}>
            Overrides the platform default. Leave blank to use the generated prompt from business config.
          </p>
          {promptError && <div className="alert alert-error" style={{ marginBottom: 8 }}>{promptError}</div>}
          {promptSaved && <div className="alert alert-success" style={{ marginBottom: 8 }}>Prompt saved.</div>}
          <textarea
            className="code"
            rows={12}
            style={{ width: '100%', boxSizing: 'border-box', marginBottom: 10 }}
            value={currentPrompt}
            onChange={(e) => { setPrompt(e.target.value); setPromptSaved(false); }}
            placeholder="Leave blank to use platform default…"
          />
          <button className="btn btn-primary" disabled={promptBusy} onClick={savePrompt}>
            {promptBusy ? 'Saving…' : 'Save prompt'}
          </button>
        </div>

        <div className="card card-pad">
          <div className="section-title">Voice receptionist</div>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <span className={`badge badge-${t.voice_enabled ? 'green' : 'gray'}`}>
                {t.voice_enabled ? 'Enabled' : 'Disabled'}
              </span>
            </dd>
            <dt>Staff transfer #</dt>
            <dd>{t.staff_phone || '—'}</dd>
            <dt>Greeting</dt>
            <dd>{t.voice_greeting || 'Generated default'}</dd>
            <dt>Voicemail email</dt>
            <dd>{t.voicemail_email || '—'}</dd>
          </dl>
        </div>

        <div className="card card-pad">
          <div className="section-title">Billing</div>
          {sub ? (
            <dl className="kv">
              <dt>Subscription</dt>
              <dd>
                <Badge value={sub.status} />
              </dd>
              <dt>Plan</dt>
              <dd>{sub.plan || '—'}</dd>
              <dt>Trial ends</dt>
              <dd>{sub.trial_ends_at ? formatDate(sub.trial_ends_at) : '—'}</dd>
              <dt>Period ends</dt>
              <dd>{sub.current_period_end ? formatDate(sub.current_period_end) : '—'}</dd>
              <dt>Cancels at period end</dt>
              <dd>{sub.cancel_at_period_end ? 'Yes' : 'No'}</dd>
              <dt>Stripe customer</dt>
              <dd className="mono">{sub.stripe_customer_id || '—'}</dd>
              <dt>Stripe subscription</dt>
              <dd className="mono">{sub.stripe_subscription_id || '—'}</dd>
            </dl>
          ) : (
            <p className="muted">No subscription on file.</p>
          )}
        </div>

        <div className="card card-pad">
          <div className="section-title">Usage this month</div>
          <dl className="kv">
            <dt>Period start</dt>
            <dd>{formatDateShort(t.usage_period_start)}</dd>
            <dt>SMS sent</dt>
            <dd>{t.monthly_sms_count ?? 0}</dd>
            <dt>SMS spend</dt>
            <dd>{usd(t.monthly_sms_spend_cents)}</dd>
            <dt>OpenAI spend</dt>
            <dd>{usd(t.monthly_openai_spend_cents)}</dd>
            <dt>SMS cap</dt>
            <dd>{t.sms_spend_cap_cents == null ? 'Uncapped' : usd(t.sms_spend_cap_cents)}</dd>
            <dt>OpenAI cap</dt>
            <dd>{t.openai_spend_cap_cents == null ? 'Uncapped' : usd(t.openai_spend_cap_cents)}</dd>
          </dl>
        </div>

        <div className="card">
          <div className="card-head">
            <h2>Phone numbers</h2>
          </div>
          {numbers.length === 0 ? (
            <div className="state">No numbers provisioned for this tenant.</div>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Number</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th>Source</th>
                    <th>Messaging service</th>
                  </tr>
                </thead>
                <tbody>
                  {numbers.map((n) => (
                    <tr key={n.id}>
                      <td className="mono" style={{ fontWeight: 600 }}>
                        {n.phone_e164}
                      </td>
                      <td>{n.number_type === 'toll_free' ? 'Toll-free' : 'Local 10DLC'}</td>
                      <td>
                        <Badge value={n.status} />
                      </td>
                      <td>{n.is_byo ? 'Bring-your-own' : 'Provisioned'}</td>
                      <td className="mono muted">{n.messaging_service_sid || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
