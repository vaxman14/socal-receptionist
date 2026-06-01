// Welcome page — shown after successful Stripe checkout.
// Step 1: Pick an area code → search numbers
// Step 2: Choose a number → provision it
// Step 3: Done — go to dashboard

import { useEffect, useState, useCallback } from 'react';
import { api } from '../lib/api';
import { Loading } from '../components/States';

export default function Welcome() {
  const [tenant, setTenant] = useState(null);
  const [loading, setLoading] = useState(true);

  // Number picker state
  const [areaCode, setAreaCode] = useState('');
  const [searching, setSearching] = useState(false);
  const [numbers, setNumbers] = useState(null);
  const [searchError, setSearchError] = useState(null);
  const [provisioning, setProvisioning] = useState(false);
  const [provisionError, setProvisionError] = useState(null);
  const [done, setDone] = useState(false);
  const [assignedNumber, setAssignedNumber] = useState(null);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const data = await api.get('/onboarding/business');
        const t = data?.tenant || null;
        if (active) {
          setTenant(t);
          // If already has a number, skip picker
          if (t?.phone_number) { setAssignedNumber(t.phone_number); setDone(true); }
        }
      } catch {
        // best-effort
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  const searchNumbers = useCallback(async (e) => {
    e.preventDefault();
    if (!/^\d{3}$/.test(areaCode)) { setSearchError('Enter a 3-digit area code.'); return; }
    setSearchError(null);
    setSearching(true);
    setNumbers(null);
    try {
      const data = await api.get(`/onboarding/numbers?areaCode=${areaCode}`);
      setNumbers(data.numbers || []);
      if (!data.numbers?.length) setSearchError(`No available numbers found for area code ${areaCode}. Try a different one.`);
    } catch (err) {
      setSearchError(err?.message || 'Search failed. Please try again.');
    } finally {
      setSearching(false);
    }
  }, [areaCode]);

  const pickNumber = useCallback(async (phoneNumber) => {
    setProvisionError(null);
    setProvisioning(true);
    try {
      const data = await api.post('/onboarding/numbers/provision', { phoneNumber });
      setAssignedNumber(data.phoneNumber);
      setDone(true);
    } catch (err) {
      setProvisionError(err?.message || 'Could not provision the number. Please try another.');
    } finally {
      setProvisioning(false);
    }
  }, []);

  return (
    <div className="wizard-wrap">
      <div className="wizard-inner" style={{ maxWidth: 640 }}>
        <div className="wizard-top" style={{ marginBottom: 32 }}>
          <a href="/" className="wizard-brand" style={{ textDecoration: 'none' }}>
            <img src="/logo-icon.svg" alt="" />
            <span className="name">SoCal Receptionist</span>
          </a>
        </div>

        <div className="card card-pad">
          {loading ? (
            <Loading label="Loading your account…" />
          ) : done ? (
            <DoneState number={assignedNumber} />
          ) : (
            <NumberPicker
              areaCode={areaCode}
              setAreaCode={setAreaCode}
              onSearch={searchNumbers}
              searching={searching}
              numbers={numbers}
              searchError={searchError}
              onPick={pickNumber}
              provisioning={provisioning}
              provisionError={provisionError}
              tenant={tenant}
            />
          )}
        </div>
      </div>
    </div>
  );
}

function NumberPicker({ areaCode, setAreaCode, onSearch, searching, numbers, searchError, onPick, provisioning, provisionError, tenant }) {
  return (
    <>
      <div style={{ textAlign: 'center', paddingBottom: 24 }}>
        <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--green-soft)', color: 'var(--green-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, margin: '0 auto 16px' }}>
          📞
        </div>
        <h1>Pick your business phone number</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          {tenant?.business_name ? `This will be ${tenant.business_name}'s AI receptionist line.` : 'This will be your AI receptionist line.'}
          {' '}Customers call this number — the AI answers 24/7.
        </p>
      </div>

      <form onSubmit={onSearch} style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <input
          type="text"
          inputMode="numeric"
          maxLength={3}
          value={areaCode}
          onChange={(e) => setAreaCode(e.target.value.replace(/\D/g, ''))}
          placeholder="Area code (e.g. 951)"
          style={{ flex: 1, maxWidth: 200 }}
          autoFocus
        />
        <button className="btn btn-primary" type="submit" disabled={searching}>
          {searching ? 'Searching…' : 'Search'}
        </button>
      </form>

      {searchError && <div className="alert alert-error" style={{ marginBottom: 16 }}>{searchError}</div>}
      {provisionError && <div className="alert alert-error" style={{ marginBottom: 16 }}>{provisionError}</div>}

      {numbers && numbers.length > 0 && (
        <>
          <p style={{ fontSize: '0.88rem', color: 'var(--muted)', marginBottom: 12 }}>
            Choose your number:
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            {numbers.map((n) => (
              <li key={n.phoneNumber}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  disabled={provisioning}
                  onClick={() => onPick(n.phoneNumber)}
                  style={{ width: '100%', display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' }}
                >
                  <span className="mono" style={{ fontWeight: 700, fontSize: '1.05rem' }}>{n.friendlyName}</span>
                  <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>{n.locality ? `${n.locality}, ${n.region}` : n.region}</span>
                </button>
              </li>
            ))}
          </ul>
          {provisioning && <p className="muted" style={{ marginTop: 12, textAlign: 'center' }}>Provisioning your number…</p>}
        </>
      )}
    </>
  );
}

function DoneState({ number }) {
  return (
    <div style={{ textAlign: 'center', padding: '8px 0' }}>
      <div style={{ width: 64, height: 64, borderRadius: '50%', background: 'var(--green-soft)', color: 'var(--green-dark)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 32, margin: '0 auto 16px' }}>
        ✅
      </div>
      <h1>You're all set!</h1>
      {number && (
        <p style={{ marginTop: 12, fontSize: '1rem' }}>
          Your AI receptionist number is<br />
          <strong className="mono" style={{ fontSize: '1.4rem', letterSpacing: 1 }}>{number}</strong>
        </p>
      )}
      <p className="muted" style={{ marginTop: 12, fontSize: '0.9rem' }}>
        Give it a call to test your AI receptionist. It's live right now.
      </p>
      <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24, flexWrap: 'wrap' }}>
        <a href="/dashboard" className="btn btn-primary">Go to my dashboard →</a>
        {number && (
          <a href={`tel:${number.replace(/\s/g, '')}`} className="btn btn-secondary">📞 Call to test</a>
        )}
      </div>
      <p className="muted" style={{ fontSize: '0.82rem', marginTop: 20 }}>
        Questions? Email <a href="mailto:support@socalreceptionist.com">support@socalreceptionist.com</a>
      </p>
    </div>
  );
}
