// Wizard step 3 — confirmation. Provisioning has started.

import { api } from '../../lib/api';
import { Badge } from '../../components/Badge';

export default function StepDone({ tenant, signResult, onContinue }) {
  const provisioning = signResult?.provisioning_started;

  const openSignedAgreement = async () => {
    // The signed agreement is HTML; open it in a new tab.
    try {
      const html = await api.get('/onboarding/agreement/signed');
      const win = window.open('', '_blank');
      if (win) {
        win.document.write(html);
        win.document.close();
      }
    } catch {
      // Non-fatal — the dashboard also links to it.
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
        <h1>You're all set</h1>
        <p className="muted" style={{ marginTop: 6 }}>
          {provisioning
            ? 'Your Service Agreement is signed and provisioning has begun.'
            : 'Your Service Agreement is on file.'}
        </p>
      </div>

      <div className="card" style={{ background: 'var(--light)' }}>
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

      <p className="muted" style={{ fontSize: '0.88rem', margin: '16px 0' }}>
        Provisioning a phone number and A2P registration can take a little time.
        Your dashboard shows live status — you'll see it move to{' '}
        <strong>active</strong> once everything is ready.
      </p>

      <div className="row-gap">
        <button className="btn btn-primary" onClick={onContinue}>
          Go to my dashboard
        </button>
        <button className="btn btn-secondary" onClick={openSignedAgreement}>
          View signed agreement
        </button>
      </div>
    </div>
  );
}
