// Onboarding wizard — 3 steps for a client who has no tenant yet.
//   1. Business profile      -> POST /onboarding/business
//   2. Sign service agreement -> POST /onboarding/agreement/sign
//   3. Confirmation           -> provisioning started, link to dashboard.

import { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import StepBusiness from './StepBusiness';
import StepAgreement from './StepAgreement';
import StepDone from './StepDone';

const STEPS = ['Your business', 'Service agreement', 'All set'];
const STORAGE_KEY = 'socal-onboard';

function loadSaved() {
  try { const s = sessionStorage.getItem(STORAGE_KEY); return s ? JSON.parse(s) : null; } catch { return null; }
}

export default function Wizard({ onComplete }) {
  const { user, signOut } = useAuth();
  const saved = loadSaved();
  const [step, setStep] = useState(saved?.step ?? 1);
  const [tenant, setTenant] = useState(saved?.tenant ?? null);
  const [signResult, setSignResult] = useState(saved?.signResult ?? null);

  useEffect(() => {
    try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ step, tenant, signResult })); } catch {}
  }, [step, tenant, signResult]);

  const handleComplete = () => {
    try { sessionStorage.removeItem(STORAGE_KEY); } catch {}
    onComplete();
  };

  return (
    <div className="wizard-wrap">
      <div className="wizard-inner">
        <div className="wizard-top">
          <div className="wizard-brand">
            <img src="/logo-icon.svg" alt="" />
            <span className="name">SoCal Receptionist</span>
          </div>
          <div className="row-gap">
            <span className="muted" style={{ fontSize: '0.84rem' }}>{user?.email}</span>
            <button className="btn btn-ghost btn-sm" onClick={signOut}>
              Sign out
            </button>
          </div>
        </div>

        <div className="steps">
          {STEPS.map((label, i) => {
            const n = i + 1;
            const cls = n < step ? 'done' : n === step ? 'active' : '';
            return (
              <div key={label} className={`step ${cls}`}>
                Step {n} · {label}
              </div>
            );
          })}
        </div>

        {step === 1 && (
          <StepBusiness
            onCreated={(t) => {
              setTenant(t);
              setStep(2);
            }}
          />
        )}

        {step === 2 && (
          <StepAgreement
            onSigned={(result) => {
              setSignResult(result);
              setStep(3);
            }}
          />
        )}

        {step === 3 && (
          <StepDone
            tenant={tenant}
            signResult={signResult}
            onContinue={handleComplete}
          />
        )}
      </div>
    </div>
  );
}
