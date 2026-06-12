import { useState } from 'react';

const SECTIONS = [
  {
    title: 'Getting Started',
    audience: 'all',
    items: [
      {
        q: 'What is SoCal Receptionist?',
        a: 'SoCal Receptionist is an AI-powered answering service for your business. When a customer calls your number, our AI picks up, greets them, answers common questions, captures leads, and sends you a summary — 24/7, no staff required.',
      },
      {
        q: 'How do I get set up?',
        a: 'Complete the onboarding wizard after signing up. You\'ll enter your business info, set your hours and services, and configure your AI\'s greeting. Once done, your account goes live and the AI starts answering calls.',
      },
      {
        q: 'What phone number do callers use?',
        a: 'A dedicated local or toll-free number is provisioned for your account during setup. This is the number you\'ll forward calls to, or use as your main business line.',
      },
      {
        q: 'Does the AI sound robotic?',
        a: 'No. We use natural-sounding voices powered by Amazon Polly and OpenAI. Most callers don\'t know they\'re talking to an AI unless told.',
      },
    ],
  },
  {
    title: 'Dashboard & Overview',
    audience: 'client',
    items: [
      {
        q: 'What does the Overview page show?',
        a: 'The Overview shows your account status, total leads captured, recent calls, and a quick summary of activity. It\'s your at-a-glance health check.',
      },
      {
        q: 'What does the status badge mean?',
        a: '"Active" means your AI receptionist is live and answering calls. "Onboarding" means setup isn\'t complete yet. "Suspended" means your account is paused — contact support.',
      },
      {
        q: 'How often does the dashboard update?',
        a: 'Data refreshes each time you load the page. Leads and calls appear within a few minutes of the interaction ending.',
      },
    ],
  },
  {
    title: 'Leads',
    audience: 'client',
    items: [
      {
        q: 'What is a lead?',
        a: 'A lead is any caller the AI captured contact information from — name, phone, reason for calling. Every lead is logged here automatically.',
      },
      {
        q: 'How do I follow up on a lead?',
        a: 'Click any lead to see the full transcript and details. Call or email them directly from there. You\'ll also receive an email notification when a new lead comes in.',
      },
      {
        q: 'Can I export my leads?',
        a: 'Lead export is on the roadmap. For now, contact support and we\'ll pull a CSV for you.',
      },
    ],
  },
  {
    title: 'Calls',
    audience: 'client',
    items: [
      {
        q: 'What shows up in the Calls log?',
        a: 'Every inbound call is logged — caller number, timestamp, duration, and whether a lead was captured. You can also listen to recordings if enabled.',
      },
      {
        q: 'Why do some calls show no lead?',
        a: 'If a caller hung up before giving their info, or called with a question that didn\'t require a callback, no lead is created. You\'ll still see the call in the log.',
      },
      {
        q: 'Does the AI leave voicemails?',
        a: 'No — the AI answers inbound calls only. It does not make outbound calls or leave voicemails.',
      },
    ],
  },
  {
    title: 'Settings',
    audience: 'client',
    items: [
      {
        q: 'What can I customize in Settings?',
        a: 'You can update your business name, services, hours, AI greeting script, voicemail email address, and your Calendly link for booking. Changes go live within a few minutes.',
      },
      {
        q: 'How do I change the AI\'s voice?',
        a: 'Voice selection is available in Settings under "AI Configuration." Options include Joanna, Salli, and others.',
      },
      {
        q: 'Can I set business hours so the AI only answers at certain times?',
        a: 'Yes. Set your hours in Settings. Outside of those hours, the AI can take a message or play a closed greeting — your choice.',
      },
      {
        q: 'What is the voicemail email?',
        a: 'After every call, a summary is emailed to this address. Set it to whoever should receive call notifications — you, your front desk, or your team.',
      },
    ],
  },
  {
    title: 'Billing',
    audience: 'client',
    items: [
      {
        q: 'What plan am I on?',
        a: 'Your current plan and renewal date are shown in the Billing tab. We offer Essentials ($500/mo) and Concierge ($500/mo + $1,500 one-time setup).',
      },
      {
        q: 'How do I update my payment method?',
        a: 'Click "Manage Billing" in the Billing tab. You\'ll be taken to a secure Stripe portal where you can update your card, download invoices, or cancel.',
      },
      {
        q: 'What happens if I exceed my call limit?',
        a: 'Additional calls are billed at $99 per 50 extra calls. You\'ll receive an email notification when you\'re approaching your limit.',
      },
      {
        q: 'Is the setup fee refundable?',
        a: 'No — the $1,500 Concierge setup fee is non-refundable. Monthly fees can be cancelled anytime with 30 days notice.',
      },
    ],
  },
  {
    title: 'Platform Admin',
    audience: 'owner',
    items: [
      {
        q: 'What is the Owner/Admin view?',
        a: 'Platform admins see all tenants (client accounts) across the platform. You can view their status, usage, billing, and configuration from one place.',
      },
      {
        q: 'How do I provision a new client?',
        a: 'New clients sign up via the registration flow at app.socalreceptionist.com. You can also run the provisioning script manually: `node scripts/provision.js` in the socal-receptionist project. It buys a Twilio number, spins up the DO app, and wires webhooks.',
      },
      {
        q: 'Where do I see all tenants?',
        a: 'The Tenants page lists every client account with their status, plan, and last activity. Click any tenant to see their full detail view.',
      },
      {
        q: 'How do I suspend or reactivate a tenant?',
        a: 'Open the tenant detail page and use the status controls. Suspending a tenant pauses their AI — calls will no longer be answered.',
      },
      {
        q: 'What is the Audit Log?',
        a: 'The Audit Log records all admin actions — who changed what and when. Use it to track configuration changes and troubleshoot issues.',
      },
      {
        q: 'How do I see a tenant\'s calls and leads?',
        a: 'From Tenant Detail, you can view their full call log and lead list. You have read-only access to all client data.',
      },
    ],
  },
  {
    title: 'Troubleshooting',
    audience: 'all',
    items: [
      {
        q: 'The AI isn\'t answering calls. What do I do?',
        a: 'First check your account status on the Overview page — it should say "Active." If active, verify your phone number is forwarding correctly. If the issue persists, email support@socalreceptionist.com.',
      },
      {
        q: 'I\'m not receiving email notifications.',
        a: 'Check your voicemail email address in Settings. Also check your spam folder — emails come from no-reply@socalreceptionist.com.',
      },
      {
        q: 'My confirmation email link expired.',
        a: 'Request a new one from the login page by clicking "Resend confirmation." Links expire after 24 hours.',
      },
      {
        q: 'How do I contact support?',
        a: 'Email support@socalreceptionist.com or call (951) 395-8776. We respond within 1 business day.',
      },
    ],
  },
];

function FAQItem({ q, a }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="faq-item" onClick={() => setOpen(o => !o)}>
      <div className="faq-q">
        <span>{q}</span>
        <span className="faq-chevron">{open ? '▲' : '▼'}</span>
      </div>
      {open && <div className="faq-a">{a}</div>}
    </div>
  );
}

export default function Help() {
  const [filter, setFilter] = useState('all');

  const visible = SECTIONS.filter(s => s.audience === 'all' || s.audience === filter || filter === 'all');

  return (
    <>
      <div className="page-head">
        <h1>Help & FAQ</h1>
        <p>Everything you need to know about using SoCal Receptionist.</p>
      </div>

      <div className="help-filter">
        {['all', 'client', 'owner'].map(f => (
          <button
            key={f}
            className={`help-filter-btn${filter === f ? ' active' : ''}`}
            onClick={() => setFilter(f)}
          >
            {f === 'all' ? 'All' : f === 'client' ? 'Business Owners' : 'Admins'}
          </button>
        ))}
      </div>

      <div className="help-sections">
        {visible.map(section => (
          <div key={section.title} className="help-section">
            <h2 className="help-section-title">{section.title}</h2>
            <div className="faq-list">
              {section.items.map(item => (
                <FAQItem key={item.q} q={item.q} a={item.a} />
              ))}
            </div>
          </div>
        ))}
      </div>

      <style>{`
        .help-filter {
          display: flex;
          gap: 8px;
          margin-bottom: 28px;
        }
        .help-filter-btn {
          padding: 7px 18px;
          border-radius: 20px;
          border: 1.5px solid #e2e8f0;
          background: #fff;
          color: #64748b;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all .15s;
        }
        .help-filter-btn.active, .help-filter-btn:hover {
          background: #0d9488;
          border-color: #0d9488;
          color: #fff;
        }
        .help-sections {
          display: flex;
          flex-direction: column;
          gap: 32px;
        }
        .help-section-title {
          font-size: 16px;
          font-weight: 700;
          color: #1b2b4b;
          margin-bottom: 12px;
          padding-bottom: 8px;
          border-bottom: 2px solid #e2e8f0;
        }
        .faq-list {
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .faq-item {
          background: #f8fafc;
          border: 1.5px solid #e2e8f0;
          border-radius: 10px;
          padding: 14px 18px;
          cursor: pointer;
          transition: border-color .15s;
        }
        .faq-item:hover {
          border-color: #0d9488;
        }
        .faq-q {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 14px;
          font-weight: 600;
          color: #1b2b4b;
          gap: 12px;
        }
        .faq-chevron {
          font-size: 10px;
          color: #94a3b8;
          flex-shrink: 0;
        }
        .faq-a {
          margin-top: 10px;
          font-size: 14px;
          color: #475569;
          line-height: 1.6;
          border-top: 1px solid #e2e8f0;
          padding-top: 10px;
        }
      `}</style>
    </>
  );
}
