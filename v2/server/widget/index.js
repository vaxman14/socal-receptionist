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
const { normalizePhone, isValidEmail } = require('../lib/validate');
const logger = require('../lib/logger');
const liveChat = require('../lib/live-chat');

const router = express.Router();

const WIDGET_JS = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
const CHAT_JS = fs.readFileSync(path.join(__dirname, 'chat-client.js'), 'utf8');

// ---- chat widget rate limiting (in-memory, per-IP + global) ----
// A public AI endpoint must not be weaponizable for free LLM calls.
const CHAT_WINDOW_MS = 10 * 60 * 1000;
const CHAT_PER_IP_MAX = 40;
const CHAT_GLOBAL_MAX = 2000;
const _chatIpHits = new Map();
let _chatGlobal = { count: 0, start: 0 };
function chatLimited(ip) {
  const now = Date.now();
  if (now - _chatGlobal.start > CHAT_WINDOW_MS) _chatGlobal = { count: 0, start: now };
  _chatGlobal.count++;
  if (_chatGlobal.count > CHAT_GLOBAL_MAX) return true;
  const h = _chatIpHits.get(ip);
  if (!h || now - h.start > CHAT_WINDOW_MS) { _chatIpHits.set(ip, { count: 1, start: now }); return false; }
  h.count++;
  return h.count > CHAT_PER_IP_MAX;
}
function reqIp(req) {
  return String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown').split(',')[0].trim();
}

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
    const { key, name, phone, email, consent, source_url } = req.body || {};

    if (!key || typeof key !== 'string') {
      return res.status(400).json({ ok: false, error: 'Missing key.' });
    }
    const e164 = normalizePhone(phone);
    if (!e164) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid phone number.' });
    }
    const cleanEmail = (typeof email === 'string' ? email.trim() : '').slice(0, 120);
    if (!isValidEmail(cleanEmail)) {
      return res.status(400).json({ ok: false, error: 'Please enter a valid email.' });
    }
    // TCPA: explicit consent to be contacted is required and recorded server-side
    // (never trust the client checkbox alone).
    if (consent !== true) {
      return res.status(400).json({ ok: false, error: 'Consent is required to be contacted.' });
    }
    const cleanName = (typeof name === 'string' ? name.trim() : '').slice(0, 80) || null;
    const cleanUrl = (typeof source_url === 'string' ? source_url.trim() : '').slice(0, 300) || null;
    const consentStamp = `Consent to contact: YES (Terms + Privacy) at ${new Date().toISOString()}`;

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
        customer_email: cleanEmail,
        service_interest: 'Website widget',
        notes: `${cleanUrl ? `Submitted from ${cleanUrl}` : 'Website callback widget'} — ${consentStamp}`,
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
            + `<p><strong>Email:</strong> ${cleanEmail}</p>`
            + `<p><strong>Page:</strong> ${cleanUrl || '—'}</p>`
            + `<p style="color:#64748b;font-size:13px">${consentStamp}</p>`,
        text: `New website lead for ${tenant.business_name}\nName: ${cleanName || '—'}\nPhone: ${e164}\nEmail: ${cleanEmail}\nPage: ${cleanUrl || '—'}\n${consentStamp}`,
      }).catch((e) => logger.error('widget.lead_email_failed', { error: e.message }));
    }

    // Confirmation email to the visitor — doubles as a consent/opt-in record.
    const firmName = tenant.business_name || 'the firm';
    sendEmail({
      to: cleanEmail,
      subject: `We got your callback request — ${firmName}`,
      html: `<p>Hi${cleanName ? ' ' + cleanName : ''},</p>`
          + `<p>This confirms you requested a callback from <strong>${firmName}</strong> and agreed to be contacted by phone about your request.</p>`
          + `<p>Someone will reach out shortly at <strong>${e164}</strong>.</p>`
          + `<p style="color:#64748b;font-size:13px">You agreed to our <a href="https://www.socalreceptionist.com/terms">Terms of Service</a> and <a href="https://www.socalreceptionist.com/privacy">Privacy Policy</a> on ${new Date().toISOString()}. If you didn't make this request, please ignore this email and you won't be contacted.</p>`,
      text: `Hi${cleanName ? ' ' + cleanName : ''},\n\nThis confirms you requested a callback from ${firmName} and agreed to be contacted by phone about your request. Someone will reach out shortly at ${e164}.\n\nYou agreed to our Terms of Service and Privacy Policy on ${new Date().toISOString()}. If you didn't make this request, please ignore this email and you won't be contacted.`,
    }).catch((e) => logger.error('widget.confirm_email_failed', { error: e.message }));

    // Component 2: trigger the AI to call the lead back from the firm's own number.
    // Fired non-blocking so the widget response stays instant. Twilio places the
    // call (caller ID = firm number) and hits /voice/callback, which resolves the
    // tenant by that number and connects the lead to the AI (is_callback=true).
    (async () => {
      const apiBase = (process.env.API_PUBLIC_BASE_URL || process.env.APP_BASE_URL || '').replace(/\/+$/, '');
      if (!apiBase || !process.env.TWILIO_ACCOUNT_SID) {
        logger.warn('widget.callback_skipped', { tenant: tenant.id, reason: 'missing twilio/base config' });
        return;
      }
      const { data: nums } = await supabase
        .from('phone_numbers')
        .select('phone_e164')
        .eq('tenant_id', tenant.id)
        .eq('status', 'active')
        .limit(1);
      const firmNumber = nums && nums[0] && nums[0].phone_e164;
      if (!firmNumber) {
        logger.warn('widget.callback_skipped', { tenant: tenant.id, reason: 'no active firm number' });
        return;
      }
      const twilio = require('twilio');
      // Pass the lead's name so the callback greets them by name and skips re-asking.
      const cbUrl = `${apiBase}/voice/callback?lead_name=${encodeURIComponent(cleanName || '')}`;
      await twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN).calls.create({
        to: e164,
        from: firmNumber,
        url: cbUrl,
        method: 'POST',
      });
      logger.info('widget.callback_fired', { tenant: tenant.id, from: firmNumber });
    })().catch((e) => logger.error('widget.callback_failed', { tenant: tenant.id, error: e.message }));

    logger.info('widget.lead', { tenant: tenant.id, hasName: !!cleanName });
    return res.json({ ok: true });
  } catch (err) {
    logger.error('widget.lead_handler_error', { error: err.message });
    return res.status(500).json({ ok: false, error: 'Server error. Please try again.' });
  }
});

// ===========================================================================
// Conversational AI chat + live human takeover
// ===========================================================================

// Serve the embeddable chat bubble script.
router.get('/chat.js', (req, res) => {
  res.set('Content-Type', 'application/javascript; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=300');
  res.send(CHAT_JS);
});

// POST /widget/chat — a visitor message. Persists, then either the AI answers
// (status 'ai') or the message is queued for the human who has taken over.
router.post('/chat', async (req, res) => {
  try {
    if (chatLimited(reqIp(req))) {
      return res.status(429).json({ error: 'Sending too fast. Please wait a moment.' });
    }
    const b = req.body || {};
    const visitorId = liveChat.clean(b.visitor, 80);
    const text = liveChat.clean(b.message, 2000);
    if (!visitorId) return res.status(400).json({ error: 'visitor required' });
    if (!text) return res.status(400).json({ error: 'empty' });

    const tenant = await liveChat.resolveTenant(liveChat.clean(b.tenant, 80));
    const business = liveChat.clean(b.business, 120) || (tenant && tenant.business_name) || '';
    const aboutParts = [liveChat.clean(b.about, 800)];
    if (tenant) {
      if (tenant.business_services) aboutParts.push(liveChat.clean(tenant.business_services, 800));
      if (tenant.ai_extra_info) aboutParts.push(liveChat.clean(tenant.ai_extra_info, 800));
    }
    const about = aboutParts.filter(Boolean).join(' — ');

    const conv = await liveChat.getOrCreateConversation({
      convId: liveChat.clean(b.conversation, 80) || null,
      visitorId,
      tenant,
      business,
      about,
      sourceUrl: liveChat.clean(b.source_url, 300),
    });

    await liveChat.addMessage(conv, 'visitor', text);

    // A human may have claimed the conversation since the last turn — re-read.
    const { data: fresh } = await supabase
      .from('chat_conversations').select('*').eq('id', conv.id).single();
    const status = (fresh && fresh.status) || 'ai';
    const humanAvailable = !!conv.tenant_id;

    if (status !== 'ai') {
      // Human is handling (or being summoned) — no AI turn; agent replies arrive via poll.
      return res.json({ conversation: conv.id, pending: true, status, human_available: humanAvailable });
    }

    // AI turn.
    const prior = await liveChat.messagesAfter(conv.id, null, null);
    let reply;
    try {
      reply = await liveChat.aiReply(liveChat.toAiHistory(prior), business, about);
    } catch (e) {
      reply = `Thanks for reaching out${business ? ` to ${business}` : ''}. Leave your name and a phone or email and the team will follow up shortly.`;
    }

    const leadMatch = reply.match(/\[LEAD:\s*name="([^"]*)"\s*contact="([^"]*)"\]/i);
    if (leadMatch) {
      liveChat.captureLead(conv, { name: leadMatch[1], contact: leadMatch[2] })
        .catch((e) => logger.error('live_chat.capture_failed', { error: e.message }));
    }
    const shown = liveChat.stripLeadTag(reply) || 'Could you tell me a bit more?';
    await liveChat.addMessage(conv, 'ai', shown);

    return res.json({ conversation: conv.id, reply: shown, status: 'ai', human_available: humanAvailable });
  } catch (err) {
    logger.error('live_chat.message_error', { error: err.message });
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// POST /widget/chat/request-human — visitor asks for a person.
router.post('/chat/request-human', async (req, res) => {
  try {
    const b = req.body || {};
    const visitorId = liveChat.clean(b.visitor, 80);
    const convId = liveChat.clean(b.conversation, 80);
    if (!visitorId || !convId) return res.status(400).json({ error: 'missing conversation' });

    const { data: conv } = await supabase
      .from('chat_conversations').select('*').eq('id', convId).maybeSingle();
    if (!conv || conv.visitor_id !== visitorId) return res.status(404).json({ error: 'not found' });

    // No tenant => no human to summon; let the AI keep going and capture a lead.
    if (!conv.tenant_id) {
      return res.json({ status: conv.status, no_human: true });
    }
    if (conv.status === 'live') return res.json({ status: 'live' });

    await supabase.from('chat_conversations')
      .update({ status: 'waiting', waiting_since: new Date().toISOString() })
      .eq('id', conv.id);
    await liveChat.addMessage(conv, 'system', 'Connecting you with the team. One moment…');

    // Notify the firm owner (best-effort): push to their app + email.
    try {
      const { data: t } = await supabase
        .from('tenants').select('business_name, voicemail_email, owner_email, owner_user_id').eq('id', conv.tenant_id).maybeSingle();
      if (t && t.owner_user_id) {
        require('../lib/push').pushToUser(t.owner_user_id, {
          title: 'A website visitor wants to chat',
          body: 'Open Live Chat to take over before the AI follows up.',
          data: { type: 'live_chat', conversation: conv.id },
        }).catch(() => {});
      }
      const to = t && (t.voicemail_email || t.owner_email);
      if (to) {
        const appBase = (process.env.WEB_BASE_URL || 'https://app2.socalreceptionist.com').replace(/\/+$/, '');
        sendEmail({
          to,
          subject: `💬 A website visitor wants to chat live — ${t.business_name || 'your site'}`,
          html: `<p>A visitor on your website asked to talk to a person right now.</p>`
              + `<p><a href="${appBase}/chat">Open Live Chat in your dashboard</a> to take over. If no one replies within a minute, the AI will take their details so you can follow up.</p>`,
          text: `A visitor on your website asked to talk to a person. Open Live Chat in your dashboard (${appBase}/chat) to take over. If no one replies within a minute, the AI will take their details.`,
        }).catch((e) => logger.error('live_chat.notify_failed', { error: e.message }));
      }
    } catch (e) { logger.error('live_chat.notify_lookup_failed', { error: e.message }); }

    return res.json({ status: 'waiting' });
  } catch (err) {
    logger.error('live_chat.request_human_error', { error: err.message });
    return res.status(500).json({ error: 'failed' });
  }
});

// GET /widget/chat/poll — visitor pulls new agent/system messages + current status.
router.get('/chat/poll', async (req, res) => {
  try {
    const visitorId = liveChat.clean(req.query.visitor, 80);
    const convId = liveChat.clean(req.query.conversation, 80);
    const after = liveChat.clean(req.query.after, 40) || null;
    if (!visitorId || !convId) return res.status(400).json({ error: 'missing conversation' });

    const { data: conv } = await supabase
      .from('chat_conversations').select('id, visitor_id, status').eq('id', convId).maybeSingle();
    if (!conv || conv.visitor_id !== visitorId) return res.status(404).json({ error: 'not found' });

    const messages = await liveChat.messagesAfter(conv.id, after, ['agent', 'system']);
    return res.json({ status: conv.status, messages });
  } catch (err) {
    logger.error('live_chat.poll_error', { error: err.message });
    return res.status(500).json({ error: 'failed' });
  }
});

module.exports = router;
