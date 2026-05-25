// Onboarding wizard — 4 steps for a client who has no tenant yet.
//   1. Business profile      -> POST /onboarding/business
//   2. Choose plan           -> stored in state (price ID sent at checkout)
//   3. Sign service agreement -> POST /onboarding/agreement/sign
//   4. Confirmation + billing -> POST /admin/billing/checkout -> Stripe

import { useState, useEffect } from 'react';
import { useAuth } from '../../context/AuthContext';
import StepBusiness from './StepBusiness';
import StepPlan from './StepPlan';
import StepAgreement from './StepAgreement';
import StepDone from './StepDone';

const STEPS = ['Your business', 'Choose plan', 'Service agreement', 'All set'];
const STORAGE_KEY = 'socal_wizard';

export default function Wizard({ onComplete }) {
  const { user, signOut } = useAuth();

  const saved = (() => {
    try {
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return parsed.userId === user?.id ? parsed : null;
    } catch { return null; }
  })();

  const [step, setStep] = useState(saved?.step ?? 1);
  const [tenant, setTenant] = useState(saved?.tenant ?? null);
  const [selectedPlan, setSelectedPlan] = useState(saved?.selectedPlan ?? null);
  const [signResult, setSignResult] = useState(saved?.signResult ?? null);

  useEffect(() => {
    if (!user) return;
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ userId: user.id, step, tenant, selectedPlan, signResult }));
  }, [step, tenant, selectedPlan, signResult, user]);

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
          <StepPlan
            onSelected={(plan) => {
              setSelectedPlan(plan);
              setStep(3);
            }}
          />
        )}

        {step === 3 && (
          <StepAgreement
            onSigned={(result) => {
              setSignResult(result);
              setStep(4);
            }}
          />
        )}

        {step === 4 && (
          <StepDone
            tenant={tenant}
            signResult={signResult}
            selectedPlan={selectedPlan}
            onContinue={() => { sessionStorage.removeItem(STORAGE_KEY); onComplete?.(); }}
          />
        )}
      </div>
    </div>
  );
}
