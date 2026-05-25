// Wizard step 2 — plan selection. No API call; stores choice in parent state.

const PLANS = [
  {
    id: 'after_hours',
    name: 'After Hours Care',
    price: '$500',
    period: '/mo',
    setup: '+ $1,500 one-time setup',
    features: [
      'AI answers calls outside business hours',
      '300 calls/month included',
      'Lead capture & email alerts',
      'Custom AI trained on your business',
    ],
  },
  {
    id: 'always_on',
    name: 'Always On',
    price: '$750',
    period: '/mo',
    setup: '+ $1,500 one-time setup',
    badge: 'Most Popular',
    features: [
      'AI answers every call, 24/7',
      '500 calls/month included',
      'Lead capture or staff transfer',
      'Custom AI trained on your business',
    ],
  },
  {
    id: 'total_care',
    name: 'Total Care',
    price: '$1,000',
    period: '/mo',
    setup: '+ $1,500 one-time setup',
    features: [
      'AI answers, qualifies, and books',
      '1,000 calls/month included',
      'Calendly / booking integration',
      'Press 2 to reach a staff member',
    ],
  },
];

export default function StepPlan({ onSelected }) {
  return (
    <div className="card card-pad">
      <h1>Choose your plan</h1>
      <p className="muted" style={{ marginBottom: 24, fontSize: '0.92rem' }}>
        All plans include a dedicated AI receptionist, email alerts, and no contracts.
        You can upgrade or cancel any time.
      </p>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {PLANS.map((plan) => (
          <button
            key={plan.id}
            type="button"
            className="plan-card"
            style={{
              display: 'block',
              width: '100%',
              textAlign: 'left',
              background: 'var(--light)',
              border: plan.badge ? '2px solid var(--orange)' : '1px solid var(--border)',
              borderRadius: 10,
              padding: '18px 20px',
              cursor: 'pointer',
              position: 'relative',
            }}
            onClick={() => onSelected(plan.id)}
          >
            {plan.badge && (
              <span
                style={{
                  position: 'absolute',
                  top: -12,
                  left: 16,
                  background: 'var(--orange)',
                  color: '#fff',
                  fontSize: '0.72rem',
                  fontWeight: 700,
                  padding: '2px 10px',
                  borderRadius: 100,
                  letterSpacing: '0.5px',
                  textTransform: 'uppercase',
                }}
              >
                {plan.badge}
              </span>
            )}
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10 }}>
              <div style={{ fontWeight: 700, fontSize: '1.05rem' }}>{plan.name}</div>
              <div style={{ textAlign: 'right' }}>
                <span style={{ fontWeight: 800, fontSize: '1.2rem' }}>{plan.price}</span>
                <span className="muted" style={{ fontSize: '0.85rem' }}>{plan.period}</span>
                <div className="muted" style={{ fontSize: '0.78rem' }}>{plan.setup}</div>
              </div>
            </div>
            <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 5 }}>
              {plan.features.map((f) => (
                <li key={f} style={{ fontSize: '0.88rem', color: 'var(--text-muted)' }}>
                  ✓ {f}
                </li>
              ))}
            </ul>
            <div
              style={{
                marginTop: 14,
                color: 'var(--orange)',
                fontWeight: 700,
                fontSize: '0.9rem',
              }}
            >
              Select this plan →
            </div>
          </button>
        ))}
      </div>

      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 16 }}>
        You'll enter billing info after signing your service agreement. The setup
        fee includes your first month of service.
      </p>
    </div>
  );
}
