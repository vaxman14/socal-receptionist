import { useState, useCallback } from 'react';
import { api } from '../../lib/api';
import { useFetch } from '../../lib/useFetch';
import { Loading, ErrorState } from '../../components/States';
import { formatDate } from '../../lib/format';

const PLAN_LABELS = {
  essentials_monthly: 'Essentials — Monthly',
  essentials_annual:  'Essentials — Annual',
  concierge_monthly:  'Concierge — Monthly',
  concierge_annual:   'Concierge — Annual',
};

function statusBadge(status) {
  const map = {
    active:   { label: 'Active',    color: 'var(--green-dark)',  bg: 'var(--green-soft)'  },
    trialing: { label: 'Trial',     color: 'var(--blue-dark)',   bg: 'var(--blue-soft)'   },
    past_due: { label: 'Past Due',  color: 'var(--red-dark)',    bg: 'var(--red-soft)'    },
    canceled: { label: 'Canceled',  color: 'var(--muted)',       bg: 'var(--surface-2)'   },
  };
  const s = map[status] || { label: status, color: 'var(--muted)', bg: 'var(--surface-2)' };
  return (
    <span style={{
      padding: '2px 10px', borderRadius: 99, fontSize: 12, fontWeight: 600,
      color: s.color, background: s.bg,
    }}>
      {s.label}
    </span>
  );
}

export default function Billing() {
  const { data, loading, error } = useFetch('/admin/me');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState(null);

  const openPortal = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const base = window.location.origin;
      const result = await api.post('/admin/billing/portal', { returnUrl: `${base}/billing` });
      if (result?.url) window.location.href = result.url;
    } catch (err) {
      setActionError(err?.message || 'Could not open billing portal. Please try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  const startCheckout = useCallback(async () => {
    setBusy(true);
    setActionError(null);
    try {
      const base = window.location.origin;
      const result = await api.post('/admin/billing/checkout', {
        planKey: 'essentials_monthly',
        successUrl: `${base}/billing?success=1`,
        cancelUrl: `${base}/billing`,
      });
      if (result?.url) window.location.href = result.url;
    } catch (err) {
      setActionError(err?.message || 'Could not start checkout. Please try again.');
    } finally {
      setBusy(false);
    }
  }, []);

  if (loading) return <Loading />;
  if (error) return <ErrorState message={error} />;

  const sub = data?.subscription;
  const isActive = sub && ['active', 'trialing'].includes(sub.status);

  return (
    <>
      <div className="page-head">
        <h1>Billing</h1>
        <p>Manage your subscription and payment method.</p>
      </div>

      {actionError && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>{actionError}</div>
      )}

      <div className="card card-pad">
        {isActive ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 20 }}>
              <div>
                <div style={{ fontSize: 13, color: 'var(--muted)', marginBottom: 4 }}>Current plan</div>
                <div style={{ fontWeight: 600, fontSize: 17 }}>
                  {PLAN_LABELS[sub.plan] || sub.plan || 'Subscription'}
                  {' '}{statusBadge(sub.status)}
                </div>
              </div>
              <button className="btn btn-secondary" onClick={openPortal} disabled={busy}>
                {busy ? 'Opening…' : 'Manage billing →'}
              </button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
              {sub.current_period_end && (
                <div className="stat-box">
                  <div className="stat-label">Next renewal</div>
                  <div className="stat-value">{formatDate(sub.current_period_end)}</div>
                </div>
              )}
              {sub.cancel_at_period_end && (
                <div className="stat-box" style={{ borderColor: 'var(--red-soft)' }}>
                  <div className="stat-label" style={{ color: 'var(--red-dark)' }}>Cancels on</div>
                  <div className="stat-value">{formatDate(sub.current_period_end)}</div>
                </div>
              )}
            </div>

            <p style={{ marginTop: 16, fontSize: 13, color: 'var(--muted)' }}>
              Update payment method, download invoices, or cancel your subscription via the billing portal.
            </p>
          </>
        ) : sub ? (
          <>
            <div style={{ marginBottom: 16 }}>
              <span style={{ fontWeight: 600 }}>Subscription status: </span>{statusBadge(sub.status)}
            </div>
            <p style={{ color: 'var(--muted)', marginBottom: 16 }}>
              Your subscription is {sub.status}. Open the billing portal to update your payment details or reactivate.
            </p>
            <button className="btn btn-primary" onClick={openPortal} disabled={busy}>
              {busy ? 'Opening…' : 'Open billing portal'}
            </button>
          </>
        ) : (
          <>
            <p style={{ marginBottom: 20 }}>You don't have an active subscription yet.</p>
            <button className="btn btn-primary" onClick={startCheckout} disabled={busy}>
              {busy ? 'Loading…' : 'Subscribe now →'}
            </button>
          </>
        )}
      </div>
    </>
  );
}
