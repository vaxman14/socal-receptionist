// Self-serve registration wizard — public-facing, no session required to start.
//
// Steps:
//   1. Your Info      — name, email, password, phone
//   2. Your Business  — business details + hours
//   3. Choose a Plan  — placeholder card (Roman fills in later)
//   4. Checkout       — creates Stripe checkout session, redirects to Stripe
//
// After Stripe payment succeeds, Stripe redirects to /welcome.

import { useState, useCallback, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { api } from '../lib/api';

const STORAGE_KEY = 'socal-register';

function loadSaved() {
  try {
    const s = sessionStorage.getItem(STORAGE_KEY);
    return s ? JSON.parse(s) : null;
  } catch { return null; }
}

const BUSINESS_TYPES = [
  'Restaurant',
  'Medical / Dental',
  'Law Firm',
  'Real Estate',
  'Salon / Spa',
  'Other',
];

const STEP_LABELS = [
  'Your Info',
  'Your Business',
  'Choose a Plan',
  'Checkout',
];

// ─── shared helpers ────────────────────────────────────────────────────────────

function StepIndicator({ current }) {
  return (
    <div className="steps" style={{ marginBottom: 28 }}>
      {STEP_LABELS.map((label, i) => {
        const n = i + 1;
        const cls = n < current ? 'done' : n === current ? 'active' : '';
        return (
          <div key={label} className={`step ${cls}`}>
            Step {n} · {label}
          </div>
        );
      })}
    </div>
  );
}

// ─── Step 1: Your Info ─────────────────────────────────────────────────────────

function StepInfo({ onNext }) {
  const { signIn, signUp } = useAuth();
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    password: '',
    confirm: '',
    phone: '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!form.full_name.trim()) return setError('Full name is required.');
    if (!form.email.trim()) return setError('Email is required.');
    if (!form.password) return setError('Password is required.');
    if (form.password.length < 8) return setError('Password must be at least 8 characters.');
    if (form.password !== form.confirm) return setError('Passwords do not match.');
    if (!form.phone.trim()) return setError('Phone number is required.');

    setBusy(true);
    try {
      // Try to sign up. If account exists, sign in instead (idempotent flow).
      let session = null;
      try {
        const data = await signUp(form.email.trim(), form.password);
        session = data.session;
        if (!session) {
          // Email confirmation required — can't proceed without session.
          setError(
            'Check your inbox to confirm your email, then return to sign in.'
          );
          return;
        }
      } catch (signUpErr) {
        // "User already registered" → try signing in instead.
        if (/already registered|already exists/i.test(signUpErr?.message || '')) {
          const data = await signIn(form.email.trim(), form.password);
          session = data.session;
        } else {
          throw signUpErr;
        }
      }

      // Pass collected info forward so Step 2 can pre-populate owner email, etc.
      onNext({
        full_name: form.full_name.trim(),
        email: form.email.trim(),
        phone: form.phone.trim(),
      });
    } catch (err) {
      setError(err?.message || 'Could not create your account. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad">
      <h1 style={{ marginBottom: 6 }}>Create your account</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: '0.92rem' }}>
        Start setting up your AI receptionist. Takes about 3 minutes.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={submit}>
        <label className="field">
          <span className="label">Full name *</span>
          <input
            type="text"
            autoComplete="name"
            value={form.full_name}
            onChange={set('full_name')}
            placeholder="Jane Smith"
          />
        </label>

        <label className="field">
          <span className="label">Email address *</span>
          <input
            type="email"
            autoComplete="email"
            value={form.email}
            onChange={set('email')}
            placeholder="jane@yourbusiness.com"
          />
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label className="field">
            <span className="label">Password *</span>
            <input
              type="password"
              autoComplete="new-password"
              value={form.password}
              onChange={set('password')}
              placeholder="At least 8 characters"
            />
          </label>
          <label className="field">
            <span className="label">Confirm password *</span>
            <input
              type="password"
              autoComplete="new-password"
              value={form.confirm}
              onChange={set('confirm')}
              placeholder="Repeat password"
            />
          </label>
        </div>

        <label className="field">
          <span className="label">Your phone number *</span>
          <input
            type="tel"
            autoComplete="tel"
            value={form.phone}
            onChange={set('phone')}
            placeholder="+1 (951) 555-0100"
          />
          <span className="hint">
            We'll use this if we ever need to reach you directly.
          </span>
        </label>

        <button className="btn btn-primary" disabled={busy} type="submit">
          {busy ? 'Creating account…' : 'Continue →'}
        </button>
      </form>

      <div className="auth-toggle" style={{ marginTop: 18 }}>
        Already have an account?{' '}
        <a href="/login">Sign in</a>
      </div>
    </div>
  );
}

// ─── Step 2: Your Business ─────────────────────────────────────────────────────

function StepBusiness({ userInfo, onNext }) {
  const [form, setForm] = useState({
    business_name: '',
    business_type: '',
    business_phone: '',
    staff_phone: '',
    business_hours: 'Mon–Fri 9am–5pm',
    business_address: '',
    voicemail_email: userInfo?.email || '',
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const submit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!form.business_name.trim()) return setError('Business name is required.');
    if (!form.business_type) return setError('Please select a business type.');
    if (!form.business_phone.trim()) return setError('Business phone is required.');
    if (!form.staff_phone.trim()) return setError('Forwarding number is required.');

    setBusy(true);
    try {
      // Check if tenant already created (idempotent).
      const existing = await api.get('/onboarding/business');
      let tenant = existing?.tenant;

      if (!tenant) {
        // Build the services string from business type.
        const business_services =
          form.business_type !== 'Other' ? form.business_type : undefined;

        const body = {
          business_name: form.business_name.trim(),
          business_hours: form.business_hours.trim() || 'Mon–Fri 9am–5pm',
          staff_phone: form.staff_phone.trim(),
          voice_enabled: true,
          voicemail_email: form.voicemail_email.trim() || userInfo?.email,
        };
        if (business_services) body.business_services = business_services;
        if (form.business_address.trim()) {
          body.business_hours =
            body.business_hours +
            ' | Address: ' +
            form.business_address.trim();
        }

        const result = await api.post('/onboarding/business', body);
        tenant = result.tenant;
      }

      onNext({ tenant, form });
    } catch (err) {
      setError(err?.message || 'Could not save your business info. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card card-pad">
      <h1 style={{ marginBottom: 6 }}>Tell us about your business</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: '0.92rem' }}>
        Your AI receptionist will use this to answer calls on your behalf.
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      <form onSubmit={submit}>
        <label className="field">
          <span className="label">Business name *</span>
          <input
            type="text"
            autoComplete="organization"
            value={form.business_name}
            onChange={set('business_name')}
            placeholder="Smith's Plumbing & Heating"
          />
        </label>

        <label className="field">
          <span className="label">Business type *</span>
          <select autoComplete="off" value={form.business_type} onChange={set('business_type')}>
            <option value="">Select a type…</option>
            {BUSINESS_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
          <label className="field">
            <span className="label">Business phone *</span>
            <input
              type="tel"
              autoComplete="off"
              value={form.business_phone}
              onChange={set('business_phone')}
              placeholder="+1 (951) 555-0200"
            />
            <span className="hint">The number your AI will answer.</span>
          </label>
          <label className="field">
            <span className="label">Forwarding number *</span>
            <input
              type="tel"
              autoComplete="off"
              value={form.staff_phone}
              onChange={set('staff_phone')}
              placeholder="+1 (951) 555-0300"
            />
            <span className="hint">Where to send live transfer requests.</span>
          </label>
        </div>

        <label className="field">
          <span className="label">Business hours</span>
          <input
            type="text"
            autoComplete="off"
            value={form.business_hours}
            onChange={set('business_hours')}
            placeholder="Mon–Fri 9am–5pm"
          />
          <span className="hint">
            The AI uses these to tell callers when you're open.
          </span>
        </label>

        <label className="field">
          <span className="label">Business address</span>
          <input
            type="text"
            autoComplete="street-address"
            value={form.business_address}
            onChange={set('business_address')}
            placeholder="123 Main St, Temecula, CA 92590"
          />
        </label>

        <label className="field">
          <span className="label">Notification email</span>
          <input
            type="email"
            autoComplete="email"
            value={form.voicemail_email}
            onChange={set('voicemail_email')}
            placeholder="owner@yourbusiness.com"
          />
          <span className="hint">
            Where missed-call alerts are sent. Defaults to your account email.
          </span>
        </label>

        <button className="btn btn-primary" disabled={busy} type="submit">
          {busy ? 'Saving…' : 'Continue →'}
        </button>
      </form>
    </div>
  );
}

// ─── Step 3: Choose a Plan (placeholder) ───────────────────────────────────────

function StepPlan({ onNext }) {
  return (
    <div className="card card-pad">
      <h1 style={{ marginBottom: 6 }}>Choose your plan</h1>
      <p className="muted" style={{ marginBottom: 24, fontSize: '0.92rem' }}>
        We keep pricing simple — one plan, everything included.
      </p>

      {/* ── PLAN OPTIONS GO HERE ── */}
      {/* When you're ready to add multiple tiers, replace the placeholder card
          below with individual plan option cards. Each card should collect a
          priceId from your Stripe dashboard and pass it to onNext(). */}
      <div
        className="card"
        style={{
          border: '2px solid var(--green)',
          borderRadius: 12,
          padding: '28px 24px',
          textAlign: 'center',
          marginBottom: 24,
          position: 'relative',
        }}
      >
        <div
          style={{
            position: 'absolute',
            top: -14,
            left: '50%',
            transform: 'translateX(-50%)',
            background: 'var(--green)',
            color: '#fff',
            fontSize: '0.78rem',
            fontWeight: 700,
            padding: '5px 18px',
            borderRadius: 999,
            whiteSpace: 'nowrap',
          }}
        >
          Most Popular in Temecula Valley
        </div>

        <div style={{ fontSize: '0.9rem', fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>
          Full-Service Plan
        </div>

        <div style={{ fontSize: '3rem', fontWeight: 800, color: 'var(--navy)', lineHeight: 1 }}>
          <span style={{ fontSize: '1.2rem', verticalAlign: 'super', fontWeight: 600, color: 'var(--muted)' }}>$</span>
          500
        </div>
        <div style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: 4 }}>per month</div>
        <div style={{ color: 'var(--muted)', fontSize: '0.85rem', marginBottom: 24 }}>
          + $1,500 one-time setup fee (billed today)
        </div>

        <ul
          style={{
            listStyle: 'none',
            textAlign: 'left',
            marginBottom: 24,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            fontSize: '0.95rem',
          }}
        >
          {[
            '24/7 AI voice receptionist',
            'Instant lead capture + qualification',
            'Email alerts for every new lead',
            'Custom AI trained on your business',
            'Staff transfer — press 2 to speak to a person',
            'Voicemail transcription',
            'No long-term contracts — cancel anytime',
          ].map((f) => (
            <li key={f} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
              <span style={{ color: 'var(--green)', fontWeight: 800, flexShrink: 0, marginTop: 1 }}>✓</span>
              {f}
            </li>
          ))}
        </ul>

        {/* Placeholder notice for future plan expansion */}
        <div
          style={{
            background: 'var(--light)',
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: '10px 14px',
            fontSize: '0.82rem',
            color: 'var(--muted)',
            marginBottom: 20,
            textAlign: 'center',
          }}
        >
          Custom enterprise plans available — our team will reach out to discuss options.
        </div>
      </div>

      <button className="btn btn-primary btn-block" onClick={() => onNext({})}>
        Continue to checkout →
      </button>
    </div>
  );
}

// ─── Step 4: Checkout ──────────────────────────────────────────────────────────

function StepCheckout({ tenant }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const startCheckout = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const base = window.location.origin;
      const data = await api.post('/admin/billing/checkout', {
        successUrl: `${base}/welcome?session_id={CHECKOUT_SESSION_ID}`,
        cancelUrl: `${base}/register`,
      });
      if (data?.url) {
        try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
        window.location.href = data.url;
      } else {
        setError('No checkout URL returned. Please try again.');
      }
    } catch (err) {
      setError(err?.message || 'Could not start checkout. Please try again.');
      setBusy(false);
    }
  }, []);

  return (
    <div className="card card-pad">
      <h1 style={{ marginBottom: 6 }}>Complete your setup</h1>
      <p className="muted" style={{ marginBottom: 20, fontSize: '0.92rem' }}>
        You'll be redirected to our secure payment page to complete your order.
      </p>

      <div className="card" style={{ background: 'var(--light)', marginBottom: 20 }}>
        <div className="card-pad">
          <dl className="kv">
            <dt>Business</dt>
            <dd>{tenant?.business_name || '—'}</dd>
            <dt>Today's charge</dt>
            <dd>
              <strong>$2,000</strong>
              <span className="muted" style={{ fontSize: '0.85rem', marginLeft: 6 }}>
                ($1,500 setup + first month $500)
              </span>
            </dd>
            <dt>Monthly after</dt>
            <dd>
              $500 / month{' '}
              <span className="muted" style={{ fontSize: '0.85rem' }}>
                (starts 30 days from today)
              </span>
            </dd>
          </dl>
        </div>
      </div>

      <div className="alert alert-info" style={{ marginBottom: 16 }}>
        14-day cancellation policy: if you cancel within 14 days, we refund $1,000
        of the setup fee. The first month ($500) is non-refundable.
      </div>

      {error && <div className="alert alert-error">{error}</div>}

      <button
        className="btn btn-primary btn-block"
        disabled={busy}
        onClick={startCheckout}
      >
        {busy ? 'Redirecting to payment…' : 'Pay now — $2,000 →'}
      </button>

      <p className="muted" style={{ fontSize: '0.78rem', textAlign: 'center', marginTop: 12 }}>
        Payments are securely processed by Stripe. Your card details never touch our servers.
      </p>
    </div>
  );
}

// ─── Root component ─────────────────────────────────────────────────────────────

export default function Register() {
  const saved = loadSaved();
  const [step, setStep] = useState(saved?.step ?? 1);
  const [userInfo, setUserInfo] = useState(saved?.userInfo ?? null);
  const [tenant, setTenant] = useState(saved?.tenant ?? null);

  useEffect(() => {
    try {
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step, userInfo, tenant }));
    } catch {}
  }, [step, userInfo, tenant]);

  return (
    <div className="wizard-wrap">
      <div className="wizard-inner">
        {/* Header */}
        <div className="wizard-top">
          <a href="/" className="wizard-brand" style={{ textDecoration: 'none' }}>
            <img src="/logo-icon.svg" alt="" />
            <span className="name">SoCal Receptionist</span>
          </a>
          <a href="/login" className="btn btn-ghost btn-sm">
            Sign in
          </a>
        </div>

        <StepIndicator current={step} />

        {step === 1 && (
          <StepInfo
            onNext={(info) => {
              setUserInfo(info);
              setStep(2);
            }}
          />
        )}

        {step === 2 && (
          <StepBusiness
            userInfo={userInfo}
            onNext={({ tenant: t }) => {
              setTenant(t);
              setStep(3);
            }}
          />
        )}

        {step === 3 && (
          <StepPlan
            onNext={() => setStep(4)}
          />
        )}

        {step === 4 && (
          <StepCheckout tenant={tenant} />
        )}
      </div>
    </div>
  );
}
