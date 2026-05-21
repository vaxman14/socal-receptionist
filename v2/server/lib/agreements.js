// Service-agreement e-signatures.
//
// A real e-signature flow, not a terms checkbox: a signer types their full
// legal name, consents to transact electronically, and the backend records an
// immutable, ESIGN/UETA-compliant signature row (db/002_agreements.sql) with a
// hash of the exact contract text plus the attribution audit trail.
//
// The contract itself is DB-managed (db/003 + lib/documents.js) so the owner
// can publish new versions from the admin. Provisioning is gated on
// hasSignedCurrent() — see provisioning/handlers.js.

const { supabase } = require('./supabase');
const { ESIGN_CONSENT_TEXT } = require('../contracts');
const { getCurrentContract } = require('./documents');

class AgreementError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AgreementError';
  }
}

// Latest non-revoked agreement for a tenant, or null.
async function getSignedAgreement(tenantId) {
  const { data, error } = await supabase
    .from('service_agreements')
    .select('*')
    .eq('tenant_id', tenantId)
    .is('revoked_at', null)
    .order('signed_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// True only if the tenant has a non-revoked signature for the CURRENT contract
// version AND the stored hash matches the current text (i.e. the contract has
// not changed since signing). A stale-version signature does not count.
async function hasSignedCurrent(tenantId) {
  const current = await getCurrentContract();
  const agreement = await getSignedAgreement(tenantId);
  return Boolean(
    agreement &&
      agreement.contract_version === current.version &&
      agreement.contract_hash === current.content_hash
  );
}

// Record a signature for the current contract version. Validates input, writes
// the immutable row, and logs to audit_log. `ip` / `userAgent` come from the
// request and form the attribution trail. Returns the inserted row.
async function recordSignature({
  tenantId,
  signerName,
  signerEmail,
  signerTitle = null,
  signerUserId = null,
  ip = null,
  userAgent = null,
}) {
  const name = (signerName || '').trim();
  const email = (signerEmail || '').trim().toLowerCase();
  if (name.length < 2) throw new AgreementError('signer_name required (full legal name)');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new AgreementError('valid signer_email required');
  }

  // One active agreement per tenant per version (DB unique index also enforces
  // this) — re-signing the current version is rejected, not duplicated.
  if (await hasSignedCurrent(tenantId)) {
    throw new AgreementError('tenant has already signed the current agreement');
  }

  const contract = await getCurrentContract();

  const { data, error } = await supabase
    .from('service_agreements')
    .insert({
      tenant_id: tenantId,
      contract_version: contract.version,
      contract_hash: contract.content_hash,
      signer_name: name,
      signer_email: email,
      signer_title: signerTitle ? String(signerTitle).trim() : null,
      signer_user_id: signerUserId,
      signer_ip: ip,
      signer_user_agent: userAgent,
      consent_text: ESIGN_CONSENT_TEXT,
    })
    .select()
    .single();
  if (error) throw error;

  await supabase.from('audit_log').insert({
    tenant_id: tenantId,
    actor_type: 'client',
    actor_user_id: signerUserId,
    action: 'service_agreement.signed',
    target_type: 'service_agreement',
    target_id: data.id,
    metadata: {
      contract_version: contract.version,
      contract_hash: contract.content_hash,
      signer_name: name,
      signer_email: email,
      ip,
    },
  });

  return data;
}

// Render the executed agreement as a standalone, printable HTML document:
// the signed contract text plus a signature/audit block. Browsers can save it
// to PDF — no PDF dependency needed. `contractText` is the exact signed text.
function renderExecutedAgreementHtml(agreement, contractText) {
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])
    );
  // Minimal, safe Markdown -> HTML for the contract body (headings, hr, paras).
  const body = esc(contractText)
    .split(/\n{2,}/)
    .map((block) => {
      const b = block.trim();
      if (!b) return '';
      if (b === '---') return '<hr>';
      const h = b.match(/^(#{1,3})\s+(.*)$/s);
      if (h) {
        const lvl = h[1].length;
        return `<h${lvl}>${h[2].replace(/\n/g, ' ')}</h${lvl}>`;
      }
      return `<p>${b.replace(/\n/g, ' ')}</p>`;
    })
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Executed Service Agreement — SoCal Receptionist</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:740px;margin:0 auto;padding:40px 24px;color:#1a1a2e;line-height:1.7}
  h1{font-size:1.5rem} h2{font-size:1.05rem;color:#4f46e5;margin-top:1.8rem} h3{font-size:.95rem}
  p,li{font-size:.92rem;color:#374151} hr{border:none;border-top:1px solid #e5e7eb;margin:1.6rem 0}
  .sigblock{margin-top:2rem;padding:20px;border:2px solid #4f46e5;border-radius:10px;background:#fafaff}
  .sigblock h2{margin-top:0} .sig-name{font-size:1.3rem;font-family:"Segoe Script","Brush Script MT",cursive;color:#1a1a2e}
  .audit{margin-top:1rem;font-size:.78rem;color:#6b7280} .audit div{margin:.15rem 0}
</style></head><body>
${body}
<div class="sigblock">
  <h2>Executed Electronically</h2>
  <p>Signed by: <span class="sig-name">${esc(agreement.signer_name)}</span></p>
  <p>${esc(agreement.signer_title || 'Authorized Representative')} &nbsp;·&nbsp; ${esc(agreement.signer_email)}</p>
  <div class="audit">
    <div><strong>Agreement ID:</strong> ${esc(agreement.id)}</div>
    <div><strong>Contract version:</strong> ${esc(agreement.contract_version)}</div>
    <div><strong>Contract hash (SHA-256):</strong> ${esc(agreement.contract_hash)}</div>
    <div><strong>Signed at:</strong> ${esc(agreement.signed_at)}</div>
    <div><strong>Signer IP:</strong> ${esc(agreement.signer_ip || 'n/a')}</div>
    <div><strong>Device:</strong> ${esc(agreement.signer_user_agent || 'n/a')}</div>
    <div style="margin-top:.6rem"><strong>Consent:</strong> ${esc(agreement.consent_text)}</div>
  </div>
</div>
</body></html>`;
}

module.exports = {
  AgreementError,
  getSignedAgreement,
  hasSignedCurrent,
  recordSignature,
  renderExecutedAgreementHtml,
};
