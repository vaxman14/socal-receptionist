// Tenant status banner — explains the tenant lifecycle state in plain language.

const COPY = {
  onboarding: {
    tone: 'info',
    title: 'Onboarding',
    text: 'Finish signing your Service Agreement to begin provisioning.',
  },
  sms_pending_compliance: {
    tone: 'warn',
    title: 'Pending carrier compliance',
    text: 'Your number is registered and we are awaiting A2P / carrier approval. Texting goes live automatically once approved.',
  },
  active: {
    tone: 'green',
    title: 'Active',
    text: 'Your AI receptionist is live and answering customers.',
  },
  suspended_billing: {
    tone: 'danger',
    title: 'Suspended — billing',
    text: 'Service is paused due to a billing issue. Update your payment method to restore service.',
  },
  suspended_compliance: {
    tone: 'danger',
    title: 'Suspended — compliance',
    text: 'Service is paused for a compliance review. Our team will be in touch.',
  },
  failed_provisioning: {
    tone: 'danger',
    title: 'Provisioning failed',
    text: 'We hit a snag setting up your number. Our team has been notified and will resolve it.',
  },
};

export function StatusBanner({ status }) {
  const c = COPY[status] || {
    tone: 'info',
    title: status || 'Unknown',
    text: 'Current account status.',
  };
  return (
    <div className={`banner banner-${c.tone}`}>
      <strong>{c.title}.</strong>
      <span>{c.text}</span>
    </div>
  );
}
