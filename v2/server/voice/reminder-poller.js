// Proactive Reminder Poller.
//
// Runs every 60 seconds. For each tenant with outbound_enabled=true:
//   1. Fetch upcoming calendar events starting in 5-10 minutes
//   2. For each event not yet reminded, insert a call_reminders row and
//      fire a Twilio outbound call to the tenant's outbound_reminder_phone
//   3. The reminder call TwiML plays a message and offers to dial the
//      attendee immediately (press 1) or dismiss (press 2)
//
// Calendar sources: Google Calendar (via tenant_integrations google_calendar)
//                   Microsoft Calendar (via tenant_integrations microsoft_calendar)
//
// Routes (Twilio webhooks):
//   POST /voice/reminder/twiml         — the reminder call TwiML
//   POST /voice/reminder/action        — DTMF response (1=dial, 2=dismiss)
//   POST /voice/remind/outbound-status — final status of reminder call

const twilio  = require('twilio');
const { supabase }  = require('../lib/supabase');
const { resolve: resolveContact } = require('../lib/contact-resolver');
const { sendEmail, brandedEmail } = require('../lib/email');
const logger  = require('../lib/logger');
const express = require('express');

const router = express.Router();
const VoiceResponse = twilio.twiml.VoiceResponse;
const VOICE  = { voice: 'Polly.Joanna-Neural' };

const REMIND_WINDOW_MIN = 5;   // start reminding N min before
const REMIND_WINDOW_MAX = 10;  // stop polling events beyond N min out

function twilioClient() {
  return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

function sendTwiml(res, vr) {
  res.type('text/xml').send(vr.toString());
}

// ── Polling loop ─────────────────────────────────────────────────────────────

async function poll() {
  // Only run when we have Twilio credentials
  if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return;

  const apiBase = (process.env.API_PUBLIC_BASE_URL || '').replace(/\/+$/, '');
  if (!apiBase) return;

  // Fetch tenants with outbound enabled. A tenant qualifies if it has a legacy
  // reminder phone OR any per-user reminder recipients (email-only is valid).
  const { data: tenants } = await supabase
    .from('tenants')
    .select('id, business_name, outbound_reminder_phone, asterisk_connector_url, asterisk_connector_key')
    .eq('outbound_enabled', true);

  if (!tenants?.length) return;

  const nowMs  = Date.now();
  const minMs  = nowMs + REMIND_WINDOW_MIN * 60 * 1000;
  const maxMs  = nowMs + REMIND_WINDOW_MAX * 60 * 1000;

  for (const tenant of tenants) {
    try {
      const { data: recipients } = await supabase
        .from('reminder_recipients')
        .select('name, match_email, call_enabled, call_phone, ext_enabled, ext_value, email_enabled, email_address')
        .eq('tenant_id', tenant.id);
      // Nothing to remind through — no recipients and no legacy phone.
      if ((!recipients || !recipients.length) && !tenant.outbound_reminder_phone) continue;
      await pollTenant(tenant, recipients || [], minMs, maxMs, apiBase);
    } catch (err) {
      logger.error('reminder-poller.tenant_failed', { tenantId: tenant.id, error: err.message });
    }
  }
}

async function pollTenant(tenant, recipients, minMs, maxMs, apiBase) {
  const events = await fetchUpcomingEvents(tenant.id, minMs, maxMs);
  if (!events.length) return;

  for (const event of events) {
    // Check if we already sent a reminder for this event
    const { data: existing } = await supabase
      .from('call_reminders')
      .select('id, status')
      .eq('tenant_id', tenant.id)
      .eq('event_id', event.id)
      .eq('event_source', event.source)
      .maybeSingle();

    if (existing) continue; // already reminded

    // Find the first external attendee with a resolvable phone
    let attendeeName  = '';
    let attendeePhone = '';
    for (const attendee of (event.attendees || [])) {
      if (!attendee.name) continue;
      const contact = await resolveContact(tenant.id, attendee.name).catch(() => null);
      if (contact && !contact.ambiguous && contact.phone) {
        attendeeName  = contact.name;
        attendeePhone = contact.phone;
        break;
      }
      // Fallback: use the attendee name even without a phone — still worth reminding
      if (!attendeeName) attendeeName = attendee.name;
    }

    // Route by event organizer → per-user recipient. Fall back to the legacy
    // single reminder phone when the organizer has no configured recipient.
    const organizer = (event.organizerEmail || '').toLowerCase();
    const recipient = organizer
      ? recipients.find(r => (r.match_email || '').toLowerCase() === organizer)
      : null;

    const willEmail = !!(recipient && recipient.email_enabled && recipient.email_address);
    // Extension reminders ring the attorney's PBX extension through their
    // on-prem Asterisk connector (a per-tenant DO droplet). Only fire when the
    // tenant actually has a connector provisioned.
    const willExt = !!(recipient && recipient.ext_enabled && recipient.ext_value
      && tenant.asterisk_connector_url && tenant.asterisk_connector_key);
    let callTo = null;
    if (recipient) {
      if (recipient.call_enabled && recipient.call_phone) callTo = recipient.call_phone;
    } else if (tenant.outbound_reminder_phone) {
      callTo = tenant.outbound_reminder_phone;
    }

    // Nothing actionable for this event/organizer — skip without writing a row.
    if (!willEmail && !willExt && !callTo) continue;

    const mins = Math.round((new Date(event.startAt).getTime() - Date.now()) / 60000);

    // Insert reminder row first (unique constraint prevents double-fire).
    const { data: reminder, error: insertErr } = await supabase
      .from('call_reminders')
      .insert({
        tenant_id:      tenant.id,
        event_id:       event.id,
        event_source:   event.source,
        attendee_name:  attendeeName  || null,
        attendee_phone: attendeePhone || null,
        event_title:    event.title   || null,
        starts_at:      new Date(event.startAt).toISOString(),
        status:         callTo ? 'calling' : 'notified',
      })
      .select()
      .single();

    if (insertErr) {
      // Duplicate key = race condition, another instance already fired it
      if (insertErr.code === '23505') continue;
      logger.error('reminder-poller.insert_failed', { tenantId: tenant.id, error: insertErr.message });
      continue;
    }

    // Email channel.
    if (willEmail) {
      const who  = attendeeName ? ` with ${attendeeName}` : (event.title ? ` for "${event.title}"` : '');
      const when = mins <= 1 ? 'in 1 minute' : `in ${mins} minutes`;
      await sendEmail({
        to:      recipient.email_address,
        subject: `Reminder: upcoming call${who} ${when}`,
        text:    `Heads up — you have a call${who} ${when}.` + (attendeePhone ? ` Contact number: ${attendeePhone}.` : ''),
        html:    brandedEmail({
          heading: '⏰ Upcoming call reminder',
          preview: `You have a call${who} ${when}`,
          bodyHtml: `<p>Heads up — you have a call${who} <strong>${when}</strong>.</p>` + (attendeePhone ? `<p style="margin:0;">Contact number: <strong>${attendeePhone}</strong></p>` : ''),
          footer: `<strong style="color:#6b7280;">${tenant.business_name || 'SoCal Receptionist'}</strong>`,
        }),
      }).catch(err => logger.warn('reminder-poller.email_failed', { tenantId: tenant.id, error: err.message }));
    }

    // Extension channel — ring the attorney's PBX extension via their on-prem
    // Asterisk connector droplet (cloud-to-cloud, bearer-authed HTTP).
    if (willExt) {
      const who  = attendeeName ? ` with ${attendeeName}` : (event.title ? ` for "${event.title}"` : '');
      const when = mins <= 1 ? 'in 1 minute' : `in ${mins} minutes`;
      const base = tenant.asterisk_connector_url.replace(/\/+$/, '');
      try {
        const resp = await fetch(`${base}/v1/reminder`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${tenant.asterisk_connector_key}`,
          },
          body: JSON.stringify({
            extension: recipient.ext_value,
            message: `Reminder: you have a call${who} ${when}.`,
          }),
          signal: AbortSignal.timeout(8000),
        });
        if (!resp.ok) throw new Error(`connector responded ${resp.status}`);
        logger.info('reminder-poller.ext_fired', { tenantId: tenant.id, ext: recipient.ext_value });
      } catch (err) {
        logger.warn('reminder-poller.ext_failed', { tenantId: tenant.id, error: err.message });
      }
    }

    // Call channel.
    if (callTo) {
      try {
        const call = await twilioClient().calls.create({
          to:   callTo,
          from: process.env.TWILIO_PHONE_NUMBER,
          url:  `${apiBase}/voice/reminder/twiml?rid=${reminder.id}&mins=${mins}&name=${encodeURIComponent(attendeeName)}&phone=${encodeURIComponent(attendeePhone)}&title=${encodeURIComponent(event.title || '')}`,
          statusCallback: `${apiBase}/voice/reminder/outbound-status?rid=${reminder.id}`,
          statusCallbackMethod: 'POST',
          statusCallbackEvent: ['completed', 'failed', 'no-answer', 'busy'],
        });

        await supabase.from('call_reminders').update({ call_sid: call.sid })
          .eq('id', reminder.id);

        logger.info('reminder-poller.call_fired', { tenantId: tenant.id, reminderId: reminder.id, callSid: call.sid });
      } catch (err) {
        await supabase.from('call_reminders').update({ status: 'failed' }).eq('id', reminder.id);
        logger.error('reminder-poller.call_failed', { tenantId: tenant.id, error: err.message });
      }
    }
  }
}

// Fetch events starting between minMs and maxMs from all connected calendars.
async function fetchUpcomingEvents(tenantId, minMs, maxMs) {
  const windowMs = maxMs - Date.now();
  const events   = [];

  // Google Calendar — token storage + refresh owned by integrations/google-calendar.js
  const { data: gCalInt } = await supabase
    .from('tenant_integrations')
    .select('enabled')
    .eq('tenant_id', tenantId).eq('provider', 'google_calendar').maybeSingle();

  if (gCalInt?.enabled) {
    try {
      const gcal = require('../integrations/google-calendar');
      const gEvents = await gcal.listUpcomingEvents(tenantId, windowMs);
      for (const e of gEvents) {
        const startMs = new Date(e.startAt).getTime();
        if (startMs >= minMs && startMs <= maxMs) {
          events.push({
            id:        e.id,
            source:    'google',
            title:     e.title,
            startAt:   e.startAt,
            attendees: e.attendees,
          });
        }
      }
    } catch (err) {
      logger.warn('reminder-poller.gcal_fetch_failed', { tenantId, error: err.message });
    }
  }

  // Microsoft Calendar
  const { data: msCalInt } = await supabase
    .from('tenant_integrations')
    .select('enabled')
    .eq('tenant_id', tenantId).eq('provider', 'microsoft_calendar').maybeSingle();

  if (msCalInt?.enabled) {
    try {
      const msCal = require('../integrations/microsoft-calendar');
      const msEvents = await msCal.listUpcomingEvents(tenantId, windowMs);
      for (const e of msEvents) {
        const startMs = new Date(e.startAt).getTime();
        if (startMs >= minMs && startMs <= maxMs) {
          events.push({ ...e, source: 'microsoft' });
        }
      }
    } catch (err) {
      logger.warn('reminder-poller.mscal_fetch_failed', { tenantId, error: err.message });
    }
  }

  return events;
}

// ── Reminder call TwiML ───────────────────────────────────────────────────────

router.post('/voice/reminder/twiml', (req, res) => {
  const reminderId   = req.query.rid;
  const minsStr      = req.query.mins || '5';
  const attendeeName = decodeURIComponent(req.query.name || '');
  const phone        = decodeURIComponent(req.query.phone || '');
  const title        = decodeURIComponent(req.query.title || '');

  const vr = new VoiceResponse();

  const who = attendeeName ? `with ${attendeeName}` : (title ? `for "${title}"` : '');
  const timeStr = minsStr === '1' ? 'in 1 minute' : `in ${minsStr} minutes`;

  const message = `Hi, you have a call ${who} ${timeStr}.`;
  const canDial  = !!phone;

  const gather = vr.gather({
    input:     'dtmf',
    numDigits: 1,
    timeout:   10,
    action:    `/voice/reminder/action?rid=${reminderId}&name=${encodeURIComponent(attendeeName)}&phone=${encodeURIComponent(phone)}`,
    method:    'POST',
  });

  gather.say(VOICE, message + (canDial
    ? ' Press 1 and I will dial them now, or press 2 to dismiss.'
    : ' Press 2 to dismiss.'
  ));

  vr.say(VOICE, 'No input received. Goodbye.');
  vr.hangup();
  sendTwiml(res, vr);
});

// ── DTMF response ─────────────────────────────────────────────────────────────

router.post('/voice/reminder/action', async (req, res) => {
  const reminderId   = req.query.rid;
  const attendeeName = decodeURIComponent(req.query.name || '');
  const phone        = decodeURIComponent(req.query.phone || '');
  const digits       = (req.body.Digits || '').trim();
  const vr           = new VoiceResponse();

  if (digits === '1' && phone) {
    await supabase.from('call_reminders').update({ status: 'bridged' }).eq('id', reminderId);

    vr.say(VOICE, `Connecting you with ${attendeeName || 'your contact'} now.`);
    const dial = vr.dial({ callerId: process.env.TWILIO_PHONE_NUMBER });
    dial.number(phone);
    return sendTwiml(res, vr);
  }

  // Dismissed or invalid key
  await supabase.from('call_reminders').update({ status: 'dismissed' }).eq('id', reminderId);
  vr.say(VOICE, 'Got it. Have a good call. Goodbye.');
  vr.hangup();
  sendTwiml(res, vr);
});

// ── Outbound status callback ──────────────────────────────────────────────────

router.post('/voice/reminder/outbound-status', async (req, res) => {
  res.sendStatus(204);
  const reminderId = req.query.rid;
  const status     = req.body.CallStatus;
  if (!reminderId) return;

  if (status === 'no-answer' || status === 'busy' || status === 'failed') {
    await supabase.from('call_reminders').update({ status: 'failed' }).eq('id', reminderId);
  }
});

// ── Start the poller ──────────────────────────────────────────────────────────

function start() {
  // Run immediately on boot, then every 60s
  poll().catch(err => logger.error('reminder-poller.initial_poll_failed', { error: err.message }));
  const interval = setInterval(() => {
    poll().catch(err => logger.error('reminder-poller.poll_failed', { error: err.message }));
  }, 60 * 1000);
  interval.unref(); // don't block process exit
  logger.info('reminder-poller.started');
}

module.exports = { router, start };
