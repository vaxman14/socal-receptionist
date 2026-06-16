// SignWell e-signature integration — embedded signing created from a template.
// Each client signs the Service Agreement inside the app (iframe). On completion
// SignWell calls our webhook (/webhooks/signwell) and we mark the tenant signed.
//
// Env:
//   SIGNWELL_API_KEY      (secret, required)
//   SIGNWELL_TEMPLATE_ID  (the Service Agreement template; defaults to the live one)
//   SIGNWELL_LIVE=true    (charge real signatures; otherwise test_mode = no billing)

const API_BASE = 'https://www.signwell.com/api/v1';
const TEMPLATE_ID = process.env.SIGNWELL_TEMPLATE_ID || '42ac8eae-8ddb-43cd-9708-0bbf83bd0aa5';
const isLive = process.env.SIGNWELL_LIVE === 'true';

function apiKey() {
  const k = process.env.SIGNWELL_API_KEY;
  if (!k) throw new Error('SIGNWELL_API_KEY is not set');
  return k;
}

// Create a document from the Service Agreement template for one signer and
// return their embedded signing URL (for an iframe). The template's recipient
// role must be named "Client" (placeholder_name).
async function createAgreementSigning({ name, email, redirectUrl } = {}) {
  if (!name || !email) throw new Error('name and email are required');
  const body = {
    template_ids: [TEMPLATE_ID],
    test_mode: !isLive,
    embedded_signing: true,
    draft: false,
    recipients: [{ id: '1', placeholder_name: 'Client', name, email }],
  };
  if (redirectUrl) body.redirect_url = redirectUrl;

  const res = await fetch(`${API_BASE}/document_templates/documents`, {
    method: 'POST',
    headers: { 'X-Api-Key': apiKey(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`SignWell create failed: ${res.status} ${JSON.stringify(data).slice(0, 400)}`);
  }
  const recipient = (data.recipients || [])[0] || {};
  return {
    documentId: data.id,
    status: data.status,
    embeddedSigningUrl: recipient.embedded_signing_url || null,
  };
}

// Fetch a document's current state — used to verify completion server-side
// (authoritative, no dependence on webhook payload shape). Returns
// { status, completed, signedPdfUrl, recipients }.
async function getDocument(documentId) {
  if (!documentId) throw new Error('documentId required');
  const res = await fetch(`${API_BASE}/documents/${encodeURIComponent(documentId)}`, {
    headers: { 'X-Api-Key': apiKey() },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`SignWell get failed: ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  const status = data.status || '';
  return {
    status,
    completed: /complete/i.test(status),
    signedPdfUrl: data.file_url || data.pdf_url || null,
    recipients: data.recipients || [],
  };
}

module.exports = { createAgreementSigning, getDocument, TEMPLATE_ID, isLive };
