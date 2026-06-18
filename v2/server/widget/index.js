// Embeddable lead-capture widget — server side.
//
//   GET  /widget/v1.js   — the embeddable client script (loads on any firm's site)
//   POST /widget/lead    — public lead submission { key, name, phone, source_url }
//
// CORS is intentionally wide open: the widget runs on third-party domains. This
// router is mounted BEFORE the app's global (origin-restricted) CORS in index.js
// so cross-site browser requests are not rejected, and it carries its own JSON
// body parser for the same reason.
//
// Component 1 (this file): render widget + capture/store/notify the lead.
// Component 2 (later): trigger /voice/callback so the AI calls the lead back.
// Component 3 (later): rate limiting + reCAPTCHA + consent guardrails.
//
// The embed key is the tenant id for now; a dedicated rotatable widget_key is a
// planned hardening step. See memory: project_socal_callback_widget.

const fs = require('fs');
const path = require('path');
const express = require('express');
const { supabase } = require('../lib/supabase');
const { sendEmail } = require('../lib/email');
const { normalizePhone } = require('../lib/validate');
const logger = require('../lib/logger');

const router = express.Router();

const WIDGET_JS = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');

// Open CORS for every /widget route + preflight short-circuit.
// The widget loads on third-party domains, so we must also relax helmet's default
// Cross-Origin-Resource-Policy (same-origin), which otherwise makes browsers block
// the script with ERR_BLOCKED_BY_RESPONSE.NotSameOrigin on any other site.
router.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Max-Age', '86400');
  res.set('Cross-Origin-Resource-Policy', 'cross-origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

router.use(express.json({ limit: '8kb' }));

// Serve the embeddable client script.
router.get('/v1.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(WIDGET_JS);
});

// Accept a lead from a firm's embedded widget.
router.post('/lead', async (req, res) => {
  try {
    const { key, name, phone, source_url } = req.body || {};

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing key.' });
    }
    const e164 = normalizePhone(phone);
    if (!e164) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid phone number.' });
    }
    const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 80) || null;
    const cleanUrl = (typeof source_url === 'string' ? source_url.trim() : '').slice(0, 300) || null;

    // Resolve the firm by embed key (tenant id for now).
    const { data: tenant, error: tErr } = await supabase
      .from('tenants')
      .select('id, business_name, voicemail_email, owner_email, status')
      .eq('id', key)
      .single();

    if (tErr || !tenant) {
      // Don't leak whether a key exists — generic response.
      return res.status(404).json({ ok: false, error: 'This form is not active. Please contact the firm directly.' });
    }

    // Store the lead (non-fatal — we still notify even if the insert fails so a
    // lead is never silently lost, mirroring the legal-survey handler).
    try {
      await supabase.from('leads').insert({
        tenant_id: tenant.id,
        customer_phone: e164,
        customer_name: cleanName,
        service_interest: 'Website widget',
        notes: cleanUrl ? `Submitted from ${cleanUrl}` : 'Website callback widget',
        status: 'qualified',
      });
    } catch (insErr) {
      logger.error('widget.lead_insert_failed', { error: insErr.message, tenant: tenant.id });
    }

    // Notify the firm.
    const notifyTo = tenant.voicemail_email || tenant.owner_email;
    if (notifyTo) {
      sendEmail({
        to: notifyTo,
        subject: `New website lead — ${cleanName || 'Unknown'} — ${tenant.business_name}`,
        html: `<p>A visitor requested a callback from your website widget.</p>`
            + `<p><strong>Name:</strong> ${cleanName || '—'}</p>`
            + `<p><strong>Phone:</strong> ${e164}</p>`
            + `<p><strong>Page:</strong> ${cleanUrl || '—'}</p>`,
        text: `New website lead for ${tenant.business_name}\nName: ${cleanName || '—'}\nPhone: ${e164}\nPage: ${cleanUrl || '—'}`,
      }).catch((e) => logger.error('widget.lead_email_failed', { error: e.message }));
    }

    logger.info('widget.lead', { tenant: tenant.id, hasName: !!cleanName });
    return res.json({ ok: true });
  } catch (err) {
    logger.error('widget.lead_handler_error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
});

module.exports = router;
