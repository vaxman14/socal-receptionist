// Status badge — maps domain status strings to a color treatment.

import { titleCase } from '../lib/format';

const TONE = {
  // tenant status
  onboarding: 'info',
  sms_pending_compliance: 'warn',
  active: 'green',
  suspended_billing: 'danger',
  suspended_compliance: 'danger',
  failed_provisioning: 'danger',
  // lead status
  new: 'info',
  qualified: 'green',
  contacted: 'warn',
  won: 'green',
  lost: 'gray',
  // conversation status
  open: 'green',
  closed: 'gray',
  // call outcome
  in_progress: 'info',
  ai_handled: 'green',
  transferred: 'info',
  voicemail: 'warn',
  missed: 'danger',
  abandoned: 'gray',
  // subscription status
  trialing: 'info',
  past_due: 'warn',
  canceled: 'gray',
  incomplete: 'gray',
};

export function Badge({ value }) {
  if (!value) return <span className="muted">—</span>;
  const tone = TONE[value] || 'gray';
  return <span className={`badge badge-${tone}`}>{titleCase(value)}</span>;
}
