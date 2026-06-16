// Onboarding API — service-agreement e-signature.
//
// Mounted at /onboarding. A tenant owner must electronically sign the Service
// Agreement before provisioning runs. Signing records an immutable, ESIGN/UETA
// signature row and enqueues the provisioning pipeline.
//
//   GET  /onboarding/agreement          -> current contract text + e-sign disclosure
//   POST /onboarding/agreement/sign     -> record signature, start provisioning
//   GET  /onboarding/agreement/signed   -> the executed agreement (HTML, printable)

const express = require('express');
const { requireAuth, requireTenant } = require('../lib/auth');
const { ESIGN_CONSENT_TEXT } = require('../contracts');
const { getCurrentContract, getContractByVersion } = require('../lib/documents');
const {
  AgreementError,
  recordSignature,
  getSignedAgreement,
  hasSignedCurrent,
  renderExecutedAgreementHtml,
} = require('../lib/agreements');
const { enqueue } = require('../lib/jobs');
const { supabase } = require('../lib/supabase');
const signwell = require('../integrations/signwell');

const router = express.Router();
router.use(requireAuth, requireTenant);

// GET /onboarding/agreement/sign-url — start a SignWell embedded signing session
// for this tenant and return the iframe URL. Maps the document to the tenant so
// completion can be recorded.
router.get('/agreement/sign-url', async (req, res) => {
  try {
    if (await hasSignedCurrent(req.tenant.id)) return res.json({ signed: true });
    const out = await signwell.createAgreementSigning({
      name: req.tenant.business_name || req.user.email,
      email: req.user.email,
    });
    await supabase.from('tenants').update({ signwell_document_id: out.documentId }).eq('id', req.tenant.id);
    res.json({ signed: false, url: out.embeddedSigningUrl, documentId: out.documentId });
  } catch (err) {
    console.error('[onboarding] signwell sign-url failed:', err.message);
    res.status(500).json({ error: 'could not start signing' });
  }
});

// GET /onboarding/agreement/signwell-complete — verify completion directly with
// SignWell (authoritative) and record the signature so the Activate step can run.
router.get('/agreement/signwell-complete', async (req, res) => {
  try {
    if (await hasSignedCurrent(req.tenant.id)) return res.json({ signed: true });
    const docId = req.tenant.signwell_document_id;
    if (!docId) return res.json({ signed: false, reason: 'no signing session' });
    const doc = await signwell.getDocument(docId);
    if (!doc.completed) return res.json({ signed: false, status: doc.status });
    const recip = (doc.recipients || [])[0] || {};
    await recordSignature({
      tenantId: req.tenant.id,
      signerName: recip.name || req.tenant.business_name || req.user.email,
      signerEmail: recip.email || req.user.email,
      signerTitle: 'Signed via SignWell',
      signerUserId: req.user.id,
      ip: req.ip,
      userAgent: req.header('user-agent') || null,
    });
    res.json({ signed: true });
  } catch (err) {
    if (err instanceof AgreementError && /already signed/i.test(err.message)) return res.json({ signed: true });
    console.error('[onboarding] signwell-complete failed:', err.message);
    res.status(500).json({ error: 'could not verify signature' });
  }
});

// GET /onboarding/agreement/status — has the tenant signed the current contract?
router.get('/agreement/status', async (req, res) => {
  try { res.json({ signed: await hasSignedCurrent(req.tenant.id) }); }
  catch (err) { res.status(500).json({ error: 'status check failed' }); }
});

// GET /onboarding/agreement — the contract to present for signing.
router.get('/agreement', async (req, res) => {
  try {
    const contract = await getCurrentContract();
    const alreadySigned = await hasSignedCurrent(req.tenant.id);
    res.json({
      version: contract.version,
      title: contract.title,
      hash: contract.content_hash,
      text: contract.body,
      esign_consent: ESIGN_CONSENT_TEXT,
      already_signed: alreadySigned,
    });
  } catch (err) {
    console.error('[onboarding] load agreement failed:', err.message);
    res.status(500).json({ error: 'could not load agreement' });
  }
});

// POST /onboarding/agreement/sign
// body: { signer_name, signer_title?, signer_email?, esign_consent: true,
//         acknowledged_version }
router.post('/agreement/sign', async (req, res) => {
  const {
    signer_name,
    signer_title,
    signer_email,
    esign_consent,
    acknowledged_version,
  } = req.body || {};

  // The signer must explicitly consent to e-sign — no silent/implied signature.
  if (esign_consent !== true) {
    return res.status(400).json({ error: 'esign_consent must be true to sign' });
  }

  try {
    // Guard against signing a version the client never saw (stale browser tab).
    const current = await getCurrentContract();
    if (acknowledged_version && acknowledged_version !== current.version) {
      return res.status(409).json({
        error: 'contract version changed — reload the agreement before signing',
        current_version: current.version,
      });
    }

    const agreement = await recordSignature({
      tenantId: req.tenant.id,
      signerName: signer_name,
      signerEmail: signer_email || req.user.email,
      signerTitle: signer_title,
      signerUserId: req.user.id,
      ip: req.ip,
      userAgent: req.header('user-agent') || null,
    });

    // NOTE: provisioning is NO LONGER kicked off here. The Activate step
    // (POST /onboarding/activate) now starts the trial and enqueues
    // provision_tenant once the client explicitly chooses to get a number.
    // The provision_tenant handler still re-checks the signature defensively.

    res.status(201).json({
      ok: true,
      agreement: {
        id: agreement.id,
        contract_version: agreement.contract_version,
        contract_hash: agreement.contract_hash,
        signer_name: agreement.signer_name,
        signer_email: agreement.signer_email,
        signed_at: agreement.signed_at,
      },
      provisioning_started: false, // moved to the Activate step
    });
  } catch (err) {
    if (err instanceof AgreementError) {
      return res.status(400).json({ error: err.message });
    }
    console.error('[onboarding] sign failed:', err.message);
    res.status(500).json({ error: 'could not record signature' });
  }
});

// GET /onboarding/agreement/signed — executed agreement as printable HTML.
router.get('/agreement/signed', async (req, res) => {
  try {
    const agreement = await getSignedAgreement(req.tenant.id);
    if (!agreement) {
      return res.status(404).json({ error: 'no signed agreement for this tenant' });
    }
    const contract = await getContractByVersion(agreement.contract_version);
    if (!contract) {
      return res.status(404).json({ error: 'signed contract version no longer available' });
    }
    res.type('text/html').send(renderExecutedAgreementHtml(agreement, contract.body));
  } catch (err) {
    console.error('[onboarding] signed-agreement render failed:', err.message);
    res.status(500).json({ error: 'could not load agreement' });
  }
});

module.exports = router;
