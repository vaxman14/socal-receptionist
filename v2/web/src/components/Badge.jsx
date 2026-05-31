// Status badge — maps domain status strings to a color treatment.

import { titleCase } from '../lib/format';

const TONE = {
  // tenant status
  onboarding: 'info',
  sms_pending_compliance: 'green',
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
  // ticket status
  draft: 'warn',
  accepted: 'green',
  rejected: 'gray',
  // subscription status
  trialing: 'info',
  past_due: 'warn',
  canceled: 'gray',
  incomplete: 'gray',
};

const LABEL = {
  sms_pending_compliance: 'Active',
};

export function Badge({ value }) {
  if (!value) return <span className="muted">—</span>;
  const tone = TONE[value] || 'gray';
  return <span className={`badge badge-${tone}`}>{LABEL[value] || titleCase(value)}</span>;
}
