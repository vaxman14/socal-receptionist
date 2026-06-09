// Wizard step 4 — agreement confirmed, trigger Stripe checkout to go live.

import { useState } from 'react';
import { api } from '../../lib/api';
import { Badge } from '../../components/Badge';
import { useAuth } from '../../context/AuthContext';

export default function StepDone({ tenant, signResult, selectedPlan, onContinue }) {
  const { user } = useAuth();
  const [checkoutBusy, setCheckoutBusy] = useState(false);
  const [checkoutError, setCheckoutError] = useState(null);
  const emailConfirmed = !!user?.email_confirmed_at;

  const openSignedAgreement = async () => {
    try {
      const html = await api.get('/onboarding/agreement/signed');
      const win = window.open('', '_blank');
      if (win) { win.document.write(html); win.document.close(); }
    } catch { /* non-fatal */ }
  };

  const startBilling = async () => {
    setCheckoutBusy(true);
    setCheckoutError(null);
    try {
      const base = window.location.origin;
      const { url } = await api.post('/admin/billing/checkout', {
        plan: selectedPlan,
        successUrl: `${base}/billing/success`,
        cancelUrl: `${base}/onboarding`,
      });
      window.location.href = url;
    } catch (err) {
      setCheckoutError(err.message || 'Could not start checkout. Please try again.');
      setCheckoutBusy(false);
    }
  };

  return (
    <div className="card card-pad">
      <div style={{ textAlign: 'center', padding: '8px 0 20px' }}>
        <div
          style={{
            width: 56,
            height: 56,
            borderRadius: '50%',
            background: 'var(--green-soft)',
            color: 'var(--green-dark)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 28,
            margin: '0 auto 14px',
          }}
        >
          ✓
        </div>
        <h1>Agreement signed</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          One last step — complete billing to activate your AI receptionist.
        </p>
      </div>

      <div className="card" style={{ background: 'var(--light)', marginBottom: 20 }}>
        <div className="card-pad">
          <dl className="kv">
            <dt>Business</dt>
            <dd>{tenant?.business_name || '—'}</dd>
            <dt>Status</dt>
            <dd>
              <Badge value={tenant?.status || 'onboarding'} />
            </dd>
            {signResult?.agreement?.contract_version && (
              <>
                <dt>Agreement</dt>
                <dd>
                  v{signResult.agreement.contract_version} · signed by{' '}
                  {signResult.agreement.signer_name}
                </dd>
              </>
            )}
          </dl>
        </div>
      </div>

      {!emailConfirmed && (
        <div className="alert alert-warning" style={{ marginBottom: 16 }}>
          <strong>Confirm your email to start your trial.</strong> We sent a confirmation link to {user?.email}. Click it, then come back here to activate.
        </div>
      )}

      {checkoutError && (
        <div className="alert alert-error" style={{ marginBottom: 16 }}>
          {checkoutError}
        </div>
      )}

      <p className="muted" style={{ fontSize: '0.88rem', marginBottom: 16 }}>
        You'll be taken to a secure Stripe checkout to enter your payment details.
        The $1,500 setup fee covers provisioning your dedicated number and your
        first month of service — recurring billing starts after 30 days.
      </p>

      <div className="row-gap">
        <button
          className="btn btn-primary"
          disabled={checkoutBusy || !emailConfirmed}
          onClick={startBilling}
        >
          {checkoutBusy ? 'Redirecting to checkout…' : 'Activate my subscription →'}
        </button>
        <button className="btn btn-ghost btn-sm" onClick={onContinue}>
          Skip for now
        </button>
      </div>

      <div style={{ marginTop: 16 }}>
        <button className="btn btn-ghost btn-sm" onClick={openSignedAgreement}>
          View signed agreement
        </button>
      </div>
    </div>
  );
}
