import { useState, useCallback } from 'react';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState } from '../../components/States';

const PLANS = [
  {
    key: 'essentials',
    name: 'Essentials',
    monthly: { key: 'essentials_monthly', price: '$500/mo', setup: null },
    annual:  { key: 'essentials_annual',  price: '$4,800/yr', note: 'Save 20%', setup: null },
    features: ['AI receptionist (calls)', 'Lead capture & CRM', 'Up to 500 calls/mo'],
  },
  {
    key: 'concierge',
    name: 'Concierge',
    monthly: { key: 'concierge_monthly', price: '$500/mo', setup: '$1,500 setup', setupNote: 'one-time' },
    annual:  { key: 'concierge_annual',  price: '$4,800/yr', note: 'Save 20%', setup: '$1,500 setup', setupNote: 'one-time' },
    features: ['Everything in Essentials', 'Custom AI persona', 'Dedicated onboarding', 'Priority support'],
  },
];

const ENTITLED = ['trialing', 'active', 'past_due'];
const REFUND_WINDOW_DAYS = 14;

function daysUntil(isoDate) {
  if (!isoDate) return null;
  return Math.ceil((new Date(isoDate) - Date.now()) / 86400000);
}

function daysAgo(isoDate) {
  if (!isoDate) return null;
  return Math.floor((Date.now() - new Date(isoDate)) / 86400000);
}

function fmtDate(isoDate) {
  if (!isoDate) return '—';
  return new Date(isoDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function Billing() {
  const me = useFetch('/admin/me');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [billing, setBilling] = useState('monthly'); // 'monthly' | 'annual'
  const [selectedPlan, setSelectedPlan] = useState('essentials');

  const callApi = useCallback(async (action, body = {}) => {
    setBusy(true);
    setErr(null);
    try {
      const data = await api.post(`/admin/billing/${action}`, body);
      if (data?.url) window.location.href = data.url;
      else setErr('Something went wrong. Please try again.');
    } catch (e) {
      setErr(e?.message || 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (me.loading) return <Loading label="Loading billing info…" />;
  if (me.error) return <ErrorState message={me.error} onRetry={me.reload} />;

  const sub = me.data?.subscription;
  const hasActiveSub = sub && ENTITLED.includes(sub.status);
  const isTrialing = sub?.status === 'trialing';
  const trialDaysLeft = isTrialing ? daysUntil(sub.trial_ends_at) : null;
  const setupDaysAgo = sub?.setup_paid_at ? daysAgo(sub.setup_paid_at) : null;
  const inRefundWindow = setupDaysAgo !== null && setupDaysAgo <= REFUND_WINDOW_DAYS;

  // ── Active / trialing subscriber ──────────────────────────────────────────
  if (hasActiveSub) {
    return (
      <>
        <div className="page-head">
          <h1>Billing</h1>
          <p>Manage your subscription and payment method.</p>
        </div>

        {isTrialing && (
          <div className="card card-pad" style={{ marginBottom: 16, borderLeft: '3px solid var(--green)' }}>
            <h3 style={{ marginBottom: 6 }}>Trial active</h3>
            <p className="muted" style={{ marginBottom: 0 }}>
              Your recurring subscription starts on <strong>{fmtDate(sub.trial_ends_at)}</strong>
              {trialDaysLeft !== null && trialDaysLeft > 0 && ` (${trialDaysLeft} days away)`}.
              Your card on file will be charged automatically.
            </p>
          </div>
        )}

        <div className="card card-pad">
          <h3 style={{ marginBottom: 8 }}>Your subscription</h3>
          <p className="muted" style={{ marginBottom: 20 }}>
            Update your payment method, download invoices, or manage your plan through the secure billing portal.
          </p>
          {err && <div className="alert alert-error" style={{ marginBottom: 16 }}>{err}</div>}
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
            <button className="btn btn-primary" onClick={() => callApi('portal')} disabled={busy}>
              {busy ? 'Opening…' : 'Manage billing →'}
            </button>
            {inRefundWindow && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  if (window.confirm(`Cancel your subscription? Since you're within ${REFUND_WINDOW_DAYS} days of signing up, you'll receive a $1,000 refund of your setup fee.`)) {
                    callApi('portal');
                  }
                }}
                disabled={busy}
                style={{ color: 'var(--red, #c0392b)' }}
              >
                Cancel subscription
              </button>
            )}
          </div>
          {inRefundWindow && (
            <p className="muted" style={{ fontSize: '0.8rem', marginTop: 12 }}>
              You're within your 14-day cancellation window. Canceling now refunds $1,000 of your setup fee automatically.
            </p>
          )}
        </div>
      </>
    );
  }

  // ── No subscription — show plan selector ─────────────────────────────────
  const planKey = `${selectedPlan}_${billing}`;

  return (
    <>
      <div className="page-head">
        <h1>Billing</h1>
        <p>Choose a plan to activate your AI receptionist.</p>
      </div>

      {err && <div className="alert alert-error" style={{ marginBottom: 16 }}>{err}</div>}

      {/* Billing toggle */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {['monthly', 'annual'].map((t) => (
          <button
            key={t}
            className={`btn ${billing === t ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1 }}
            onClick={() => setBilling(t)}
          >
            {t === 'monthly' ? 'Monthly' : 'Annual (Save 20%)'}
          </button>
        ))}
      </div>

      {/* Plan cards */}
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', marginBottom: 24 }}>
        {PLANS.map((plan) => {
          const tier = plan[billing];
          const selected = selectedPlan === plan.key;
          return (
            <div
              key={plan.key}
              className="card card-pad"
              onClick={() => setSelectedPlan(plan.key)}
              style={{
                flex: '1 1 220px',
                cursor: 'pointer',
                border: selected ? '2px solid var(--green-dark)' : '2px solid var(--border)',
                position: 'relative',
              }}
            >
              {selected && (
                <span style={{
                  position: 'absolute', top: 10, right: 12,
                  background: 'var(--green-dark)', color: '#fff',
                  fontSize: '0.7rem', fontWeight: 700, padding: '2px 8px', borderRadius: 20,
                }}>Selected</span>
              )}
              <h3 style={{ marginBottom: 4 }}>{plan.name}</h3>
              <div style={{ fontSize: '1.4rem', fontWeight: 700, color: 'var(--green-dark)', marginBottom: 2 }}>
                {tier.price}
              </div>
              {tier.setup && (
                <div className="muted" style={{ fontSize: '0.82rem', marginBottom: 8 }}>
                  + {tier.setup} ({tier.setupNote})
                </div>
              )}
              {tier.note && (
                <div style={{ fontSize: '0.82rem', color: 'var(--green-dark)', fontWeight: 600, marginBottom: 8 }}>
                  {tier.note}
                </div>
              )}
              <ul style={{ paddingLeft: 16, margin: 0, fontSize: '0.85rem', color: 'var(--muted)' }}>
                {plan.features.map((f) => <li key={f}>{f}</li>)}
              </ul>
            </div>
          );
        })}
      </div>

      <div className="card card-pad" style={{ background: 'var(--surface-alt, #f9f9fb)' }}>
        <p className="muted" style={{ fontSize: '0.85rem', marginBottom: 16 }}>
          Cancel within 14 days and receive a $1,000 refund. No long-term contracts.
        </p>
        <button
          className="btn btn-primary btn-block"
          onClick={() => callApi('checkout', { planKey })}
          disabled={busy}
        >
          {busy ? 'Redirecting to checkout…' : `Subscribe — ${PLANS.find(p => p.key === selectedPlan)[billing].price} →`}
        </button>
      </div>
    </>
  );
}
