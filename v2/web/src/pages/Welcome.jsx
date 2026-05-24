// Welcome page — shown after successful Stripe checkout.
//
// Stripe redirects here with ?session_id=<id> after a successful payment.
// Fetches the tenant to show their assigned phone number and next steps.

import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Loading } from '../components/States';

export default function Welcome() {
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await api.get('/onboarding/business');
        if (active) setTenant(data?.tenant || null);
      } catch (err) {
        if (active) setError(err?.message || 'Could not load your account.');
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  return (
    <div className="wizard-wrap">
      <div className="wizard-inner" style={{ maxWidth: 640 }}>
        {/* Header */}
        <div className="wizard-top" style={{ marginBottom: 32 }}>
          <a href="/" className="wizard-brand" style={{ textDecoration: 'none' }}>
            <img src="/logo-icon.svg" alt="" />
            <span className="name">SoCal Receptionist</span>
          </a>
          <a href="/dashboard" className="btn btn-ghost btn-sm">
            Go to dashboard
          </a>
        </div>

        <div className="card card-pad">
          {/* Success icon */}
          <div style={{ textAlign: 'center', padding: '8px 0 24px' }}>
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: '50%',
                background: 'var(--green-soft)',
                color: 'var(--green-dark)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 32,
                margin: '0 auto 16px',
              }}
            >
              🎉
            </div>
            <h1>Welcome to SoCal Receptionist!</h1>
            <p className="muted" style={{ marginTop: 8, fontSize: '0.96rem' }}>
              Your payment was received and your AI receptionist is being set up.
            </p>
          </div>

          {loading ? (
            <Loading label="Loading your account…" />
          ) : error ? (
            <div className="alert alert-error">{error}</div>
          ) : (
            <>
              {tenant && (
                <div className="card" style={{ background: 'var(--light)', marginBottom: 24 }}>
                  <div className="card-pad">
                    <dl className="kv">
                      <dt>Business</dt>
                      <dd>{tenant.business_name || '—'}</dd>
                      <dt>Status</dt>
                      <dd>
                        <span
                          className={`badge ${
                            tenant.status === 'active'
                              ? 'badge-green'
                              : tenant.status === 'onboarding'
                              ? 'badge-warn'
                              : 'badge-gray'
                          }`}
                        >
                          {tenant.status || 'provisioning'}
                        </span>
                      </dd>
                      {tenant.phone_number && (
                        <>
                          <dt>Your AI receptionist number</dt>
                          <dd>
                            <strong className="mono" style={{ fontSize: '1.1rem' }}>
                              {tenant.phone_number}
                            </strong>
                          </dd>
                        </>
                      )}
                    </dl>
                  </div>
                </div>
              )}

              {/* Next steps */}
              <div style={{ marginBottom: 24 }}>
                <div className="section-title" style={{ marginBottom: 12 }}>
                  What happens next
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                  <Step
                    num={1}
                    done={!!tenant?.phone_number}
                    label="Your receptionist number is assigned"
                    desc="We're provisioning a dedicated phone number for your business. This usually takes a few minutes."
                  />
                  <Step
                    num={2}
                    done={false}
                    label="AI is trained on your business"
                    desc="Our team reviews your info and fine-tunes the AI greeting, call handling, and lead capture flow."
                  />
                  <Step
                    num={3}
                    done={false}
                    label="Test your receptionist"
                    desc={
                      tenant?.phone_number
                        ? `Call ${tenant.phone_number} to hear your AI receptionist in action.`
                        : 'Once your number is assigned, give it a call to hear your AI receptionist in action.'
                    }
                  />
                </div>
              </div>

              {tenant?.phone_number && (
                <div className="alert alert-success" style={{ marginBottom: 20 }}>
                  Your AI receptionist is live! Call{' '}
                  <strong>{tenant.phone_number}</strong> to test it.
                </div>
              )}

              <div className="row-gap">
                <a href="/dashboard" className="btn btn-primary">
                  Go to my dashboard →
                </a>
                {tenant?.phone_number && (
                  <a
                    href={`tel:${tenant.phone_number.replace(/\s/g, '')}`}
                    className="btn btn-secondary"
                  >
                    📞 Call to test
                  </a>
                )}
              </div>

              <p className="muted" style={{ fontSize: '0.82rem', marginTop: 20 }}>
                Questions? Email us at{' '}
                <a href="mailto:support@socalreceptionist.com">
                  support@socalreceptionist.com
                </a>{' '}
                — a real human will respond within a few hours.
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function Step({ num, done, label, desc }) {
  return (
    <div
      style={{
        display: 'flex',
        gap: 14,
        padding: '12px 0',
        borderBottom: '1px solid var(--border)',
      }}
    >
      <div
        style={{
          width: 28,
          height: 28,
          borderRadius: '50%',
          background: done ? 'var(--green)' : 'var(--light)',
          border: done ? 'none' : '2px solid var(--border)',
          color: done ? '#fff' : 'var(--muted)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: done ? 14 : '0.82rem',
          fontWeight: 700,
          flexShrink: 0,
          marginTop: 2,
        }}
      >
        {done ? '✓' : num}
      </div>
      <div>
        <div style={{ fontWeight: 600, color: 'var(--navy)', marginBottom: 2 }}>
          {label}
        </div>
        <div style={{ fontSize: '0.86rem', color: 'var(--muted)' }}>{desc}</div>
      </div>
    </div>
  );
}
