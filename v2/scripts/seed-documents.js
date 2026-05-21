// Seed editable documents (migration 003).
//
// Populates legal_documents with starter content for all six policy/info pages
// and ensures the v1 e-sign contract exists. Re-runnable: legal_documents are
// upserted by slug, the contract auto-seeds only if absent.
//
// Run after applying db/003_documents.sql:
//   node scripts/seed-documents.js
//
// Requires SUPABASE_URL + SUPABASE_SERVICE_KEY in the environment (.env).

require('dotenv').config();
const { upsertDocument, getCurrentContract } = require('../server/lib/documents');

// Starter markdown for each page. Edit freely afterwards in the owner admin —
// these are just sane defaults so nothing renders empty.
const SEED_DOCS = {
  privacy: {
    title: 'Privacy Policy',
    body: `# Privacy Policy

_Last updated: May 2026_

SoCal Receptionist provides an AI-powered virtual receptionist for small
businesses in Southern California. This policy explains how we handle
information.

## Information We Collect
- Phone numbers of people who text a business using our service.
- Message content, processed to generate replies.
- Opt-in / opt-out consent status.

## SMS Opt-In Consent
No automated messages are sent until a person replies YES to a consent prompt.
Anyone may reply STOP to opt out at any time.

## How We Use Information
To answer inquiries, maintain consent compliance, and improve the service. We
do not sell or rent personal information.

## Third-Party Services
We use Twilio for SMS delivery and OpenAI for AI responses; each processes data
under its own privacy policy.

## Contact
Questions? Email info@socalreceptionist.com.`,
  },
  terms: {
    title: 'Terms of Use',
    body: `# Terms of Use

_Last updated: May 2026_

By using the SoCal Receptionist SMS service you agree to these terms.

## The Service
An AI-powered virtual receptionist delivered via SMS that answers inquiries,
shares business information, and helps schedule appointments.

## Acceptable Use
Do not use the service for unlawful purposes, harassment, spam, or attempts to
disrupt or reverse-engineer the system.

## AI-Generated Responses
Responses are AI-generated and may be inaccurate. They are not professional
advice. Confirm important details directly with the business.

## No Warranties / Limitation of Liability
The service is provided "as is". To the fullest extent permitted by law, we are
not liable for indirect or consequential damages.

## Governing Law
These terms are governed by the laws of California; disputes are resolved in
Riverside County, California.

## Contact
Email info@socalreceptionist.com.`,
  },
  cookies: {
    title: 'Cookie Policy',
    body: `# Cookie Policy

_Last updated: May 2026_

This policy explains how the SoCal Receptionist website uses cookies.

## What We Use
Only essential session cookies needed for basic site functionality.

## What We Do Not Use
No advertising, tracking, analytics, or social-media cookies that collect
personal information for marketing.

## SMS Service
Our SMS service does not use cookies; this policy applies to website visits
only.

## Managing Cookies
You can control cookies through your browser settings.

## Contact
Email info@socalreceptionist.com.`,
  },
  accessibility: {
    title: 'Accessibility Statement',
    body: `# Accessibility Statement

_Last updated: May 2026_

SoCal Receptionist is committed to digital accessibility for people with
disabilities.

## Our Commitment
We aim to conform to WCAG 2.1 Level AA.

## Measures We Take
- Semantic HTML for screen-reader compatibility
- Sufficient color contrast
- Descriptive links and keyboard navigation

## SMS Accessibility
Our SMS service uses plain text, compatible with most assistive technologies.

## Feedback
Email accessibility feedback to info@socalreceptionist.com; we aim to respond
within 2 business days.`,
  },
  faq: {
    title: 'Frequently Asked Questions',
    body: `# Frequently Asked Questions

_Last updated: May 2026_

## For Customers

**What is SoCal Receptionist?** An AI assistant that participating businesses
use to answer text messages — questions, business info, and scheduling.

**Am I talking to a real person?** No, responses are AI-generated on behalf of
the business.

**How do I stop messages?** Reply STOP at any time.

**Will I be charged?** We don't charge you; standard carrier message/data rates
may apply.

## For Businesses

**Can I keep my existing number?** Yes — calls can be forwarded and an existing
number can be text-enabled without porting.

**How fast is setup?** The product is quick; carrier registration for business
texting (A2P 10DLC) takes a few business days.

**What does it cost?** A one-time setup fee plus a flat monthly rate. Contact us
for a quote.

## Still have questions?
Email info@socalreceptionist.com.`,
  },
  support: {
    title: 'Support',
    body: `# Support

_Last updated: May 2026_

## Contact Us
- Email: info@socalreceptionist.com
- Location: Murrieta, CA

We aim to respond within 1 business day.

## Text-Message Keywords
- **STOP** — opt out of all automated messages
- **HELP** — get assistance and contact information
- **YES** — opt in after the consent prompt

## Common Questions
- **Not receiving replies?** Check you haven't replied STOP; text the business
  again and reply YES to opt back in.
- **Replied STOP by mistake?** Text the business again and reply YES.

## For Business Owners
To update business info, billing, or phone settings, email us with the details.`,
  },
};

async function main() {
  let ok = 0;
  for (const [slug, doc] of Object.entries(SEED_DOCS)) {
    await upsertDocument(slug, doc, null);
    console.log(`  seeded legal_document: ${slug}`);
    ok += 1;
  }

  // Ensure the e-sign contract exists (auto-seeds v1 from the shipped file).
  const contract = await getCurrentContract();
  console.log(`  current contract: ${contract.version} (${contract.content_hash.slice(0, 12)}…)`);

  console.log(`Done — ${ok} legal documents + contract ${contract.version}.`);
}

main().catch((err) => {
  console.error('seed-documents failed:', err.message);
  process.exit(1);
});
