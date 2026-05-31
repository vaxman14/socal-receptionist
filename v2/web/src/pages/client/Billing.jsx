import { useState, useCallback } from 'react';
import { useFetch } from '../../lib/useFetch';
import { api } from '../../lib/api';
import { Loading, ErrorState } from '../../components/States';

const ENTITLED = ['trialing', 'active', 'past_due'];

export default function Billing() {
  const me = useFetch('/admin/me');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const openPortal = useCallback(async () => {
    setBusy(true);
    setErr(null);
    try {
      const data = await api.post('/admin/billing/portal', {});
      if (data?.url) {
        window.location.href = data.url;
      } else {
        setErr('Could not open billing portal. Please try again.');
        setBusy(false);
      }
    } catch (e) {
      setErr(e?.message || 'Could not open billing portal.');
      setBusy(false);
    }
  }, []);

  if (me.loading) return <Loading label="Loading billing info…" />;
  if (me.error) return <ErrorState message={me.error} onRetry={me.reload} />;

  const sub = me.data?.subscription;
  const hasActiveSub = sub && ENTITLED.includes(sub.status);

  return (
    <>
      <div className="page-head">
        <h1>Billing</h1>
        <p>Manage your subscription and payment method.</p>
      </div>

      <div className="card card-pad">
        {hasActiveSub ? (
          <>
            <h3 style={{ marginBottom: 8 }}>Your subscription</h3>
            <p className="muted" style={{ marginBottom: 20 }}>
              Manage your plan, update your payment method, or download invoices through our secure billing portal.
            </p>
            {err && <div className="alert alert-error" style={{ marginBottom: 16 }}>{err}</div>}
            <button className="btn btn-primary" onClick={openPortal} disabled={busy}>
              {busy ? 'Opening…' : 'Manage billing →'}
            </button>
          </>
        ) : (
          <div className="state">
            <h3>No active subscription</h3>
            <p style={{ maxWidth: 440, margin: '8px auto 20px' }}>
              Complete your account setup to activate your AI receptionist.
            </p>
            <a href="/register" className="btn btn-primary">Complete setup →</a>
          </div>
        )}
      </div>
    </>
  );
}
