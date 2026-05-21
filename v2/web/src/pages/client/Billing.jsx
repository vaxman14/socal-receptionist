// Client Billing — placeholder. Stripe is not connected yet, so we do NOT
// call /admin/billing/* here.

export default function Billing() {
  return (
    <>
      <div className="page-head">
        <h1>Billing</h1>
        <p>Manage your subscription and payment method.</p>
      </div>

      <div className="card card-pad">
        <div className="state">
          <div
            style={{
              width: 52,
              height: 52,
              borderRadius: '50%',
              background: 'var(--green-soft)',
              color: 'var(--green-dark)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 24,
              margin: '0 auto 14px',
            }}
          >
            ⌛
          </div>
          <h3>Billing &amp; subscriptions — coming soon</h3>
          <p style={{ maxWidth: 460, margin: '6px auto 0' }}>
            Online billing is being finalized. For now, your account is managed
            directly by the SoCal Receptionist team — reach out with any billing
            questions and we'll take care of it.
          </p>
        </div>
      </div>
    </>
  );
}
