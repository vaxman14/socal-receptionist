// Wizard step 2 — plan selection. No API call; stores choice in parent state.
import { useState } from 'react';

const PLANS = [
  {
    id: 'after_hours',
    name: 'After Hours Care',
    monthly: { price: '$500', setup: '+ $1,500 one-time setup', period: '/mo' },
    annual:  { price: '$400', setup: '+ $1,005 one-time setup', period: '/mo', note: 'billed $4,800/yr' },
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
    monthly: { price: '$750', setup: '+ $1,500 one-time setup', period: '/mo' },
    annual:  { price: '$600', setup: '+ $1,005 one-time setup', period: '/mo', note: 'billed $7,200/yr' },
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
    monthly: { price: '$1,000', setup: '+ $1,500 one-time setup', period: '/mo' },
    annual:  { price: '$800',   setup: '+ $1,005 one-time setup', period: '/mo', note: 'billed $9,600/yr' },
    features: [
      'AI answers, qualifies, and books',
      '1,000 calls/month included',
      'Calendly / booking integration',
      'Press 2 to reach a staff member',
    ],
  },
];

export default function StepPlan({ onSelected }) {
  const [billing, setBilling] = useState('monthly');
  const isAnnual = billing === 'annual';

  return (
    <div className="card card-pad">
      <h1>Choose your plan</h1>
      <p className="muted" style={{ marginBottom: 16, fontSize: '0.92rem' }}>
        All plans include a dedicated AI receptionist, email alerts, and no contracts.
        You can upgrade or cancel any time.
      </p>

      {/* Billing toggle */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 24, justifyContent: 'center' }}>
        <button
          type="button"
          onClick={() => setBilling('monthly')}
          style={{
            padding: '6px 18px',
            borderRadius: 100,
            border: 'none',
            fontWeight: 600,
            fontSize: '0.88rem',
            cursor: 'pointer',
            background: !isAnnual ? 'var(--orange)' : 'var(--light)',
            color: !isAnnual ? '#fff' : 'var(--text-muted)',
          }}
        >
          Monthly
        </button>
        <button
          type="button"
          onClick={() => setBilling('annual')}
          style={{
            padding: '6px 18px',
            borderRadius: 100,
            border: 'none',
            fontWeight: 600,
            fontSize: '0.88rem',
            cursor: 'pointer',
            background: isAnnual ? 'var(--orange)' : 'var(--light)',
            color: isAnnual ? '#fff' : 'var(--text-muted)',
          }}
        >
          Annual
        </button>
        {isAnnual && (
          <span style={{
            background: '#dcfce7',
            color: '#166534',
            fontSize: '0.75rem',
            fontWeight: 700,
            padding: '2px 10px',
            borderRadius: 100,
          }}>
            Save 20% + 33% off setup
          </span>
        )}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {PLANS.map((plan) => {
          const pricing = isAnnual ? plan.annual : plan.monthly;
          const planId = isAnnual ? `${plan.id}_annual` : plan.id;
          return (
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
              onClick={() => onSelected(planId)}
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
                  <span style={{ fontWeight: 800, fontSize: '1.2rem' }}>{pricing.price}</span>
                  <span className="muted" style={{ fontSize: '0.85rem' }}>{pricing.period}</span>
                  <div className="muted" style={{ fontSize: '0.78rem' }}>{pricing.setup}</div>
                  {pricing.note && (
                    <div style={{ fontSize: '0.72rem', color: '#166534', fontWeight: 600 }}>{pricing.note}</div>
                  )}
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
          );
        })}
      </div>

      <p className="muted" style={{ fontSize: '0.8rem', marginTop: 16 }}>
        You'll enter billing info after signing your service agreement. The setup
        fee includes your first {isAnnual ? 'year' : 'month'} of service.
      </p>
    </div>
  );
}
