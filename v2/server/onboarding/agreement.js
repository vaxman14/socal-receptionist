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

const router = express.Router();
router.use(requireAuth, requireTenant);

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

    // Signing is what kicks off provisioning. provision_tenant is idempotent
    // (no-ops unless the tenant is still 'onboarding'), and its handler also
    // re-checks the signature as a defensive gate.
    if (req.tenant.status === 'onboarding') {
      await enqueue(req.tenant.id, 'provision_tenant', {});
    }

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
      provisioning_started: req.tenant.status === 'onboarding',
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
