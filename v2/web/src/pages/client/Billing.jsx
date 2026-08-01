import { useState, useCallback } from 'react';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState } from '../../components/States';

const ENTITLED = ['trialing', 'active', 'past_due'];
const PLAN = {
  monthly: { key: 'monthly', price: '$69/month', detail: 'Billed monthly' },
  annual: { key: 'annual', price: '$690/year', detail: 'Save $138 · two months free' },
};

function daysUntil(isoDate) {
  if (!isoDate) return null;
  return Math.ceil((new Date(isoDate) - Date.now()) / 86400000);
}

function fmtDate(isoDate) {
  if (!isoDate) return '—';
  return new Date(isoDate).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

export default function Billing() {
  const me = useFetch('/admin/me');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [billing, setBilling] = useState('monthly');

  const callApi = useCallback(async (action, body = {}) => {
    setBusy(true);
    setErr(null);
    try {
      const data = await api.post(`/admin/billing/${action}`, body);
      if (data?.url) window.location.href = data.url;
      else setErr('Something went wrong. Please try again.');
    } catch (error) {
      setErr(error?.message || 'Something went wrong.');
    } finally { setBusy(false); }
  }, []);

  if (me.loading) return <Loading label="Loading billing info…" />;
  if (me.error) return <ErrorState message={me.error} onRetry={me.reload} />;

  const sub = me.data?.subscription;
  const tenant = me.data?.tenant;
  const hasStripeCustomer = !!sub?.stripe_customer_id;
  const hasManagedSub = sub && ENTITLED.includes(sub.status) && hasStripeCustomer;
  const isTrialing = sub?.status === 'trialing';
  const trialEndsAt = tenant?.trial_ends_at || sub?.trial_ends_at || null;
  const trialDaysLeft = trialEndsAt ? daysUntil(trialEndsAt) : null;
  const trialEnded = !!trialEndsAt && new Date(trialEndsAt) <= new Date();
  const checkoutState = new URLSearchParams(window.location.search).get('checkout');

  if (hasManagedSub) {
    return (
      <>
        <div className="page-head"><h1>Billing</h1><p>Manage your subscription and payment method.</p></div>
        {checkoutState === 'success' && <div className="alert alert-success" style={{ marginBottom: 16 }}>Billing is set up. Your first charge will occur after the free trial ends.</div>}
        {isTrialing && (
          <div className="card card-pad" style={{ marginBottom: 16, borderLeft: '3px solid var(--green)' }}>
            <h3 style={{ marginBottom: 6 }}>30-day trial active</h3>
            <p className="muted" style={{ marginBottom: 0 }}>
              Your card will be charged when the trial ends on <strong>{fmtDate(sub.trial_ends_at)}</strong>.
            </p>
          </div>
        )}
        <div className="card card-pad">
          <h3 style={{ marginBottom: 8 }}>Your subscription</h3>
          <p className="muted">Update your payment method, download invoices, switch billing, or cancel through Stripe.</p>
          {err && <div className="alert alert-error" style={{ marginBottom: 16 }}>{err}</div>}
          <button className="btn btn-primary" onClick={() => callApi('portal')} disabled={busy}>{busy ? 'Opening…' : 'Manage billing →'}</button>
        </div>
      </>
    );
  }

  const choice = PLAN[billing];
  return (
    <>
      <div className="page-head"><h1>Billing</h1><p>One plan. Choose monthly or annual billing.</p></div>
      {checkoutState === 'cancel' && <div className="alert alert-info" style={{ marginBottom: 16 }}>Checkout was canceled. Your free trial is still active.</div>}
      {trialEndsAt && !trialEnded && (
        <div className="card card-pad" style={{ marginBottom: 16, borderLeft: '3px solid var(--green)' }}>
          <h3 style={{ marginBottom: 6 }}>30-day free trial active</h3>
          <p className="muted" style={{ marginBottom: 0 }}>
            Your receptionist is live{trialDaysLeft > 0 && <> with <strong>{trialDaysLeft} day{trialDaysLeft === 1 ? '' : 's'} left</strong></>}. Add a card now; you will not be charged before <strong>{fmtDate(trialEndsAt)}</strong>.
          </p>
        </div>
      )}
      {trialEnded && (
        <div className="card card-pad" style={{ marginBottom: 16, borderLeft: '3px solid var(--red, #c0392b)' }}>
          <h3 style={{ marginBottom: 6 }}>Your trial has ended</h3>
          <p className="muted" style={{ marginBottom: 0 }}>Choose a billing option below to reactivate your receptionist.</p>
        </div>
      )}
      {err && <div className="alert alert-error" style={{ marginBottom: 16 }}>{err}</div>}
      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {Object.keys(PLAN).map((key) => (
          <button key={key} className={`btn ${billing === key ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: 1 }} onClick={() => setBilling(key)}>
            {key === 'monthly' ? 'Monthly' : 'Annual · 2 months free'}
          </button>
        ))}
      </div>
      <div className="card card-pad" style={{ marginBottom: 20, border: '2px solid var(--green-dark)' }}>
        <h3>SoCal Receptionist</h3>
        <div style={{ fontSize: '1.8rem', fontWeight: 800, color: 'var(--green-dark)', margin: '6px 0' }}>{choice.price}</div>
        <p className="muted">{choice.detail}</p>
        <ul style={{ paddingLeft: 18 }}>
          <li>24/7 AI call answering</li>
          <li>Lead capture and email summaries</li>
          <li>Optional Google or Microsoft calendar booking</li>
          <li>AI-powered self onboarding</li>
          <li>Email support when you need help</li>
        </ul>
      </div>
      <button className="btn btn-primary btn-block" onClick={() => callApi('checkout', { planKey: choice.key })} disabled={busy}>
        {busy ? 'Redirecting to checkout…' : `Choose ${choice.price} →`}
      </button>
      <p className="muted" style={{ fontSize: '0.78rem', textAlign: 'center', marginTop: 12 }}>Secure checkout by Stripe. Cancel before the trial ends to avoid a charge.</p>
    </>
  );
}
