// Owner Tenant Detail — one tenant: profile, voice, billing, usage, numbers.
// GET /admin/owner/tenants/:id  ->  { tenant: { ...tenant, subscriptions, phone_numbers } }

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState } from '../../components/States';
import { Badge } from '../../components/Badge';
import { formatDate, formatDateShort } from '../../lib/format';

// Spend caps + usage counters are stored in cents.
function usd(cents) {
  if (cents === null || cents === undefined) return '—';
  return `$${(Number(cents) / 100).toFixed(2)}`;
}

// Service agreements card — list + revoke. Revocation is permanent (the row
// stays for the audit trail; only revoked_at is set).
function AgreementsCard({ tenantId }) {
  const { data, loading, error, reload } = useFetch(`/admin/owner/tenants/${tenantId}/agreements`);
  const [busyId, setBusyId] = useState(null);
  const [revokeError, setRevokeError] = useState(null);

  async function revoke(agreement) {
    const ok = window.confirm(
      `Revoke service agreement ${agreement.contract_version} signed by ${agreement.signer_name}? This cannot be undone.`
    );
    if (!ok) return;
    setBusyId(agreement.id);
    setRevokeError(null);
    try {
      await api.post(`/admin/owner/agreements/${agreement.id}/revoke`);
      reload();
    } catch (err) {
      setRevokeError(err.message || 'Revocation failed');
    } finally {
      setBusyId(null);
    }
  }

  const agreements = data?.agreements || [];

  return (
    <div className="card">
      <div className="card-head">
        <h2>Service agreements</h2>
      </div>
      {loading ? (
        <div className="state">Loading agreements…</div>
      ) : error ? (
        <div className="state">Could not load agreements: {error}</div>
      ) : agreements.length === 0 ? (
        <div className="state">No executed agreements on file.</div>
      ) : (
        <div className="table-wrap">
          {revokeError && (
            <p className="state" style={{ color: 'var(--red, #c0392b)' }}>{revokeError}</p>
          )}
          <table className="data">
            <thead>
              <tr>
                <th>Version</th>
                <th>Signer</th>
                <th>Signed</th>
                <th>Status</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {agreements.map((a) => (
                <tr key={a.id}>
                  <td className="mono">{a.contract_version}</td>
                  <td>
                    {a.signer_name}
                    {a.signer_email ? <span className="muted"> · {a.signer_email}</span> : null}
                  </td>
                  <td>{formatDate(a.signed_at)}</td>
                  <td>
                    {a.revoked_at ? (
                      <span className="badge badge-gray">Revoked {formatDateShort(a.revoked_at)}</span>
                    ) : (
                      <span className="badge badge-green">Active</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    {!a.revoked_at && (
                      <button
                        className="btn btn-danger btn-sm"
                        disabled={busyId === a.id}
                        onClick={() => revoke(a)}
                      >
                        {busyId === a.id ? 'Revoking…' : 'Revoke'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// Platform-admin billing/plan/lifecycle controls. Owner-only actions in the
// product sense (billing + close) are gated server-side to platform admins.
function BillingManager({ tenantId, sub, tenant, onSaved }) {
  const [plan, setPlan] = useState(sub?.plan || '');
  const [price, setPrice] = useState(
    sub?.custom_price_cents != null ? (sub.custom_price_cents / 100).toString() : ''
  );
  const [status, setStatus] = useState(sub?.status || 'trialing');
  const [trial, setTrial] = useState(sub?.trial_ends_at ? sub.trial_ends_at.slice(0, 10) : '');
  const [cancelEnd, setCancelEnd] = useState(!!sub?.cancel_at_period_end);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [err, setErr] = useState(null);

  async function call(path, body, label) {
    setBusy(true); setErr(null); setMsg(null);
    try {
      await api.patch(path, body);
      setMsg(`${label} saved.`);
      onSaved();
    } catch (e) {
      setErr(e.message || 'Save failed');
    } finally {
      setBusy(false);
    }
  }

  const savePlan = () =>
    call(`/admin/owner/tenants/${tenantId}/plan`, {
      plan: plan || null,
      custom_price_cents: price === '' ? null : Math.round(Number(price) * 100),
    }, 'Plan');

  const saveBilling = () =>
    call(`/admin/owner/tenants/${tenantId}/billing`, {
      status,
      trial_ends_at: trial ? new Date(trial).toISOString() : null,
      cancel_at_period_end: cancelEnd,
    }, 'Billing');

  const setSetup = (paid) =>
    call(`/admin/owner/tenants/${tenantId}/billing`, { setup_paid: paid }, 'Setup fee');
  const setRefund = (refunded) =>
    call(`/admin/owner/tenants/${tenantId}/billing`, { setup_refunded: refunded }, 'Refund');

  const setTenantStatus = (s, confirmMsg) => {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    call(`/admin/owner/tenants/${tenantId}/status`, { status: s }, 'Account');
  };

  return (
    <div className="card card-pad">
      <div className="section-title">Manage billing &amp; plan</div>
      {err && <p className="state" style={{ color: 'var(--red, #c0392b)' }}>{err}</p>}
      {msg && <p className="state" style={{ color: 'var(--green, #1f8a4c)' }}>{msg}</p>}

      <div className="kv" style={{ gridTemplateColumns: '1fr', gap: 14 }}>
        <div>
          <label className="muted" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 4 }}>Plan</label>
          <select value={plan} onChange={(e) => setPlan(e.target.value)} disabled={busy} style={{ width: '100%' }}>
            <option value="">—</option>
            <option value="essentials_monthly">Essentials (monthly)</option>
            <option value="essentials_annual">Essentials (annual)</option>
            <option value="concierge_monthly">Concierge (monthly)</option>
            <option value="concierge_annual">Concierge (annual)</option>
          </select>
        </div>
        <div>
          <label className="muted" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 4 }}>
            Custom monthly price (USD) — overrides plan price; blank = standard
          </label>
          <input type="number" min="0" step="1" placeholder="e.g. 1500" value={price}
            onChange={(e) => setPrice(e.target.value)} disabled={busy} style={{ width: '100%' }} />
        </div>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={savePlan}>Save plan &amp; price</button>
      </div>

      <hr style={{ border: 0, borderTop: '1px solid #eef0f6', margin: '16px 0' }} />

      <div className="kv" style={{ gridTemplateColumns: '1fr', gap: 14 }}>
        <div>
          <label className="muted" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 4 }}>Subscription status</label>
          <select value={status} onChange={(e) => setStatus(e.target.value)} disabled={busy} style={{ width: '100%' }}>
            {['trialing', 'active', 'past_due', 'canceled', 'unpaid', 'incomplete'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="muted" style={{ display: 'block', fontSize: '0.8rem', marginBottom: 4 }}>Trial ends (comp / extend)</label>
          <input type="date" value={trial} onChange={(e) => setTrial(e.target.value)} disabled={busy} style={{ width: '100%' }} />
        </div>
        <label style={{ fontSize: '0.85rem' }}>
          <input type="checkbox" checked={cancelEnd} onChange={(e) => setCancelEnd(e.target.checked)} disabled={busy} /> Cancel at period end
        </label>
        <button className="btn btn-primary btn-sm" disabled={busy} onClick={saveBilling}>Save billing</button>
      </div>

      <hr style={{ border: 0, borderTop: '1px solid #eef0f6', margin: '16px 0' }} />

      <div className="row-gap" style={{ flexWrap: 'wrap', gap: 8 }}>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setSetup(true)}>Mark setup paid</button>
        <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setRefund(true)}>Mark setup refunded</button>
        {tenant.status === 'active' ? (
          <button className="btn btn-danger btn-sm" disabled={busy}
            onClick={() => setTenantStatus('suspended_billing', `Suspend ${tenant.business_name}? Voice will be disabled.`)}>
            Suspend account
          </button>
        ) : (
          <button className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setTenantStatus('active')}>
            Reactivate account
          </button>
        )}
      </div>
    </div>
  );
}

export default function TenantDetail() {
  const { id } = useParams();
  const { data, loading, error, reload } = useFetch(`/admin/owner/tenants/${id}`);

  if (loading) return <Loading label="Loading tenant…" />;
  if (error) return <ErrorState message={error} onRetry={reload} />;

  const t = data?.tenant;
  if (!t) return <ErrorState message="Tenant not found." />;

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
            <dt>Prompt override</dt>
            <dd>{t.ai_system_prompt ? 'Custom' : 'Platform default'}</dd>
            <dt>Created</dt>
            <dd>{formatDate(t.created_at)}</dd>
            <dt>Activated</dt>
            <dd>{t.activated_at ? formatDate(t.activated_at) : '—'}</dd>
          </dl>
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

        <BillingManager tenantId={id} sub={sub} tenant={t} onSaved={reload} />

        <div className="card card-pad">
          <div className="section-title">Usage this month</div>
          <dl className="kv">
            <dt>Period start</dt>
            <dd>{formatDateShort(t.usage_period_start)}</dd>
            <dt>OpenAI spend</dt>
            <dd>{usd(t.monthly_openai_spend_cents)}</dd>
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

        <AgreementsCard tenantId={id} />
      </div>
    </>
  );
}
