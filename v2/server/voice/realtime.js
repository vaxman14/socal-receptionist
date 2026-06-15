// OpenAI Realtime API voice handler for SoCal Receptionist V2.
//
// Architecture:
//   Caller → Twilio Media Stream (WebSocket) → this handler → OpenAI Realtime (WebSocket)
//   No round-trip TTS/STT loop — audio streams bidirectionally in real time.
//
// Twilio sends G.711 μ-law (mulaw/pcmu) audio; OpenAI Realtime accepts audio/pcmu natively.
// No audio format conversion needed.

const WebSocket = require('ws');
const twilio = require('twilio');
const { supabase } = require('../lib/supabase');
const { buildSystemPrompt } = require('../lib/ai');
const { getOrCreateConversation } = require('../lib/conversations');
const { recordCallStart, updateCall } = require('../lib/calls');
const { sendEmail } = require('../lib/email');
const logger = require('../lib/logger');

const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const RECORDING_TENANT_IDS = new Set(
  (process.env.RECORDING_TENANT_IDS || '').split(',').filter(Boolean)
);

// Polly voice ID → OpenAI Realtime voice (best quality matches)
const POLLY_TO_REALTIME = {
  'Polly.Joanna-Neural':  'marin',
  'Polly.Matthew-Neural': 'cedar',
  'Polly.Salli-Neural':   'shimmer',
  'Polly.Joey-Neural':    'echo',
  'Polly.Amy-Neural':     'coral',
  'Polly.Brian-Neural':   'verse',
};

const REALTIME_MODEL = 'gpt-realtime-2025-08-28';
const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

// We request PCM16 (24kHz) from OpenAI and transcode to G.711 mu-law (8kHz)
// ourselves, then feed Twilio. Asking OpenAI for audio/pcmu directly produced
// garbled "wind/roar" audio (PCM bytes played as mu-law). This is bulletproof.
function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0F;
  return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

// Hard per-call duration ceiling. A real receptionist call wraps inside 10
// minutes; anything longer is either a stuck stream or someone freeloading.
const MAX_CALL_MS = 10 * 60 * 1000;

// Tools available to the AI receptionist during a call.
function buildTools(tenant) {
  const tools = [
    {
      type: 'function',
      name: 'capture_lead',
      description: "Record a qualified lead once you have the caller's name, a callback number, and the service they need.",
      parameters: {
        type: 'object',
        properties: {
          name:    { type: 'string', description: "Caller's name" },
          contact: { type: 'string', description: 'Callback phone number' },
          service: { type: 'string', description: 'Service or help the caller needs' },
          notes:   { type: 'string', description: 'Any other relevant detail' },
        },
        required: ['name', 'contact', 'service'],
      },
    },
    {
      type: 'function',
      name: 'transfer_to_staff',
      description: 'Transfer the caller to a human staff member.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Why the caller needs a human' },
        },
        required: [],
      },
    },
  ];
  return tools;
}

// Handle one Twilio Media Stream WebSocket connection.
function handleMediaStream(twilioWs, req) {
  let openaiWs = null;
  let callSid = null;
  let streamSid = null;
  let tenantId = null;
  let fromNumber = null;
  let tenant = null;
  let conversationId = null;
  let pendingFunctionCalls = new Map();
  let leadCaptured = false;
  let recordingEnabled = false;
  let isCallback = false;
  let ourNumber = null;
  let transcript = []; // { role: 'caller'|'ai', text: string }
  let wrapUpTimer = null;
  let hardStopTimer = null;

  // --- Outbound audio pacing + barge-in (fixes garbled/overlapping playback) ---
  // OpenAI emits audio faster than real time and in bursts; queue the raw mu-law
  // bytes and feed Twilio steady 20ms (160-byte) frames. Drop audio from stale/
  // cancelled responses so two streams never interleave into a grinding sound.
  let playQueue = Buffer.alloc(0);
  let drainTimer = null;
  let currentResponseId = null;
  let assistantSpeaking = false;
  let pcmRemainder = Buffer.alloc(0); // leftover PCM16 bytes between deltas
  let dbgAudioDeltas = 0; // TEMP diag: audio deltas in the current response
  const FRAME_BYTES = 160; // 20ms of 8kHz G.711 mu-law

  // TEMP diag: buffer a trace of the OpenAI event lifecycle and Telegram it on
  // hang-up, since DO run-logs and DB writes are not observable right now.
  const dbgTrace = [];
  let dbgSent = false;
  function dbg(s) { dbgTrace.push(`${new Date().toISOString().slice(11, 19)} ${s}`); }
  function sendDbgTrace() {
    if (dbgSent) return;
    dbgSent = true;
    const tok = process.env.TELEGRAM_BOT_TOKEN;
    if (!tok || dbgTrace.length === 0) return;
    const text = '🩺 VOICE TRACE\n' + dbgTrace.join('\n').slice(0, 3500);
    fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: '6335227029', text }),
    }).catch(() => {});
  }

  // Decode a base64 PCM16@24kHz delta from OpenAI, downsample to 8kHz (average
  // groups of 3 samples) and mu-law encode → bytes ready for Twilio.
  function pcmDeltaToMulaw(b64) {
    const buf = Buffer.concat([pcmRemainder, Buffer.from(b64, 'base64')]);
    const samples = Math.floor(buf.length / 2);
    const groups = Math.floor(samples / 3);
    const out = Buffer.alloc(groups);
    for (let g = 0; g < groups; g++) {
      const i = g * 6;
      const avg = ((buf.readInt16LE(i) + buf.readInt16LE(i + 2) + buf.readInt16LE(i + 4)) / 3) | 0;
      out[g] = linearToMulaw(avg);
    }
    pcmRemainder = buf.subarray(groups * 6); // carry leftover samples/bytes
    return out;
  }

  function startDrain() {
    if (drainTimer) return;
    drainTimer = setInterval(() => {
      if (!streamSid || playQueue.length === 0) return;
      const frame = playQueue.subarray(0, FRAME_BYTES);
      playQueue = playQueue.subarray(frame.length);
      try {
        twilioWs.send(JSON.stringify({
          event: 'media',
          streamSid,
          media: { payload: frame.toString('base64') },
        }));
      } catch {}
    }, 20);
  }

  function flushPlayback() {
    playQueue = Buffer.alloc(0);
    pcmRemainder = Buffer.alloc(0);
    if (streamSid) {
      try { twilioWs.send(JSON.stringify({ event: 'clear', streamSid })); } catch {}
    }
  }

  logger.info('voice.realtime.stream_connected');

  // Open the OpenAI Realtime WebSocket immediately.
  openaiWs = new WebSocket(OPENAI_WS_URL, {
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
  });

  openaiWs.on('open', () => {
    logger.info('voice.realtime.openai_connected');
  });

  openaiWs.on('message', async (data) => {
    const event = JSON.parse(data);

    switch (event.type) {

      case 'session.created': {
        // Session is ready — configure it with our prompt + tools.
        if (tenant) configureSession();
        break;
      }

      case 'response.created': {
        currentResponseId = (event.response && event.response.id) || currentResponseId;
        assistantSpeaking = true;
        dbgAudioDeltas = 0;
        dbg(`resp.created ${currentResponseId}`);
        break;
      }

      case 'response.done': {
        assistantSpeaking = false;
        dbg(`resp.done status=${event.response?.status} audioDeltas=${dbgAudioDeltas} detail=${JSON.stringify(event.response?.status_details || {}).slice(0,200)}`);
        break;
      }

      // Queue AI audio, transcoded to mu-law and paced to Twilio in 20ms frames.
      case 'response.output_audio.delta': {
        if (event.delta) {
          dbgAudioDeltas++;
          try { playQueue = Buffer.concat([playQueue, pcmDeltaToMulaw(event.delta)]); } catch {}
        }
        break;
      }

      case 'input_audio_buffer.speech_started':
        dbg('caller speech_started');
        break;
      case 'input_audio_buffer.speech_stopped':
        dbg('caller speech_stopped');
        break;
      case 'input_audio_buffer.committed':
        dbg('input committed');
        break;

      // AI wants to call a function.
      case 'response.function_call_arguments.done': {
        const callId = event.call_id;
        const fnName = event.name;
        let args = {};
        try { args = JSON.parse(event.arguments || '{}'); } catch (e) {}
        await handleFunctionCall(callId, fnName, args);
        break;
      }

      // Caller speech transcription (requires input_audio_transcription in session).
      case 'conversation.item.input_audio_transcription.completed': {
        dbg(`caller said: "${(event.transcript || '').trim().slice(0, 80)}"`);
        if (event.transcript) transcript.push({ role: 'caller', text: event.transcript.trim() });
        break;
      }

      // AI speech transcription.
      case 'response.audio_transcript.done': {
        if (event.transcript) transcript.push({ role: 'ai', text: event.transcript.trim() });
        break;
      }

      case 'error': {
        dbg(`OAI_ERROR ${JSON.stringify(event.error || {}).slice(0, 300)}`);
        logger.error('voice.realtime.openai_error', { error: event.error });
        break;
      }
    }
  });

  openaiWs.on('close', () => logger.info('voice.realtime.openai_closed'));
  openaiWs.on('error', (err) => logger.error('voice.realtime.openai_ws_error', { error: err.message }));

  let sessionConfigured = false;
  function configureSession() {
    if (sessionConfigured) return; // run once — double-config fired two greetings and wedged turn-taking
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    if (!tenant) return;
    sessionConfigured = true;
    dbg('configureSession (once)');
    const realtimeVoice = POLLY_TO_REALTIME[tenant.voice_id] || 'coral';
    const instructions = buildSystemPrompt(tenant, { channel: 'voice', callerPhone: fromNumber });
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true },
            // Caller speech transcription. GA API: belongs under input, NOT output.
            // (It was under output, which made OpenAI reject the whole session.update
            // -> turn_detection never applied -> AI went silent after the greeting.)
            transcription: { model: 'gpt-4o-mini-transcribe' },
          },
          output: {
            // PCM16@24kHz — we transcode to mu-law 8kHz ourselves (pcmDeltaToMulaw).
            format: { type: 'audio/pcm', rate: 24000 },
            voice: realtimeVoice,
          },
        },
        instructions,
        tools: buildTools(tenant),
        tool_choice: 'auto',
      },
    }));

    // Trigger the AI to greet the caller.
    const disclosurePrefix = recordingEnabled
      ? 'First say: "This call may be recorded for quality and training purposes." Then, '
      : '';
    const callbackGreeting = `Hi, I'm calling back from ${tenant.business_name} — looks like your call got disconnected. I just wanted to make sure I can help you. How can I assist you today?`;
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: isCallback
          ? `${disclosurePrefix}Say this greeting exactly: "${callbackGreeting}"`
          : tenant.voice_greeting
            ? `${disclosurePrefix}Say this greeting exactly: "${tenant.voice_greeting}"`
            : `${disclosurePrefix}greet the caller by saying "Thank you for calling ${tenant.business_name}," then ask how you can help. One sentence. Do not mention AI or virtual receptionist.`,
      },
    }));
  }

  async function handleFunctionCall(callId, fnName, args) {
    let result = 'ok';

    if (fnName === 'capture_lead') {
      try {
        const contact = args.contact || fromNumber;
        const notes = [contact ? `Contact: ${contact}` : null, args.notes].filter(Boolean).join(' — ');
        await supabase.from('leads').insert({
          tenant_id: tenantId,
          conversation_id: conversationId,
          customer_phone: fromNumber,
          customer_name: args.name || null,
          service_interest: args.service || null,
          notes: notes || null,
          status: 'qualified',
        });
        const notifyTo = tenant?.voicemail_email || tenant?.owner_email;
        if (notifyTo) {
          await sendEmail({
            to: notifyTo,
            subject: `New lead — ${args.name || 'Unknown'} — ${tenant.business_name}`,
            html: `<p><strong>Name:</strong> ${args.name || '—'}</p><p><strong>Phone:</strong> ${fromNumber || '—'}</p><p><strong>Callback:</strong> ${contact || '—'}</p><p><strong>Service:</strong> ${args.service || '—'}</p><p><strong>Notes:</strong> ${args.notes || '—'}</p>`,
            text: `New lead for ${tenant?.business_name}\nName: ${args.name || '—'}\nPhone: ${fromNumber || '—'}\nService: ${args.service || '—'}`,
          });
        }
        leadCaptured = true;
        result = 'Lead captured. Thank the caller and confirm someone will follow up.';
      } catch (err) {
        logger.error('voice.realtime.capture_lead_failed', { error: err.message });
        result = 'error: ' + err.message;
      }
    }

    if (fnName === 'transfer_to_staff') {
      const staffPhone = tenant?.staff_phone;
      if (staffPhone && callSid) {
        // Use Twilio REST to redirect the live call to staff.
        const baseUrl = (process.env.APP_BASE_URL || 'https://socal-receptionist-v2-spbrw.ondigitalocean.app').replace(/\/+$/, '');
        twilioClient.calls(callSid).update({
          twiml: `<Response><Say voice="${tenant.voice_id || 'Polly.Joanna-Neural'}">One moment while I connect you with our team.</Say><Dial timeout="20" action="${baseUrl}/voice/dial-status">${staffPhone}</Dial></Response>`,
        }).catch((err) => logger.error('voice.realtime.transfer_failed', { error: err.message }));
        result = 'Transfer initiated.';
      } else {
        result = 'No staff phone configured. Tell the caller someone will call them back shortly.';
      }
    }

    // Send the function result back to OpenAI so it can respond.
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: result,
        },
      }));
      openaiWs.send(JSON.stringify({ type: 'response.create' }));
    }
  }

  // Handle messages from Twilio.
  twilioWs.on('message', async (data) => {
    const msg = JSON.parse(data);

    switch (msg.event) {

      case 'start': {
        streamSid = msg.start.streamSid;
        startDrain(); // begin paced 20ms outbound audio frames
        callSid   = msg.start.callSid;
        // Custom parameters passed from the TwiML <Stream>.
        const params = msg.start.customParameters || {};
        tenantId   = params.tenant_id;
        fromNumber = params.from_number;
        isCallback = params.is_callback === 'true';
        ourNumber  = params.to_number || '+19513958776';

        // Load the tenant and set up the call record.
        if (tenantId) {
          const { data: t } = await supabase
            .from('tenants')
            .select('*')
            .eq('id', tenantId)
            .maybeSingle();
          tenant = t;

          if (tenant) {
            const conv = await getOrCreateConversation(tenant.id, fromNumber).catch(() => null);
            conversationId = conv?.id || null;
          }
        }

        if (callSid) {
          await recordCallStart({ tenantId, callSid, from: fromNumber, to: null }).catch(() => {});
        }

        // Start recording for enabled tenants.
        if (callSid && RECORDING_TENANT_IDS.has(tenantId)) {
          recordingEnabled = true;
          const baseUrl = (process.env.APP_BASE_URL || 'https://socal-receptionist-v2-spbrw.ondigitalocean.app').replace(/\/+$/, '');
          twilioClient.calls(callSid).recordings.create({
            recordingChannels: 'dual',
            recordingStatusCallback: `${baseUrl}/voice/recording-status`,
            recordingStatusCallbackMethod: 'POST',
            recordingStatusCallbackEvent: ['completed'],
          }).catch(err => logger.error('voice.recording.start_failed', { error: err.message }));
        }

        // Notify the tenant of every inbound call, regardless of outcome.
        if (tenant) {
          const notifyTo = tenant.voicemail_email || tenant.owner_email;
          if (notifyTo) {
            const ts = new Date().toLocaleString('en-US', {
              timeZone: tenant.timezone || 'America/Los_Angeles',
              dateStyle: 'medium',
              timeStyle: 'short',
            });
            sendEmail({
              to: notifyTo,
              subject: `📞 Incoming call — ${tenant.business_name}`,
              html: `<p>Someone just called <strong>${tenant.business_name}</strong>.</p><p><strong>From:</strong> ${fromNumber || 'unknown'}<br/><strong>Time:</strong> ${ts}</p>`,
              text: `Incoming call to ${tenant.business_name}\nFrom: ${fromNumber || 'unknown'}\nTime: ${ts}`,
            }).catch(() => {});
          }
        }

        // If openaiWs is already open, configure now; otherwise the open handler will.
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          configureSession();
        }

        // Hard duration cap — Realtime API + Twilio both bill per minute.
        // Warn the model to wrap up, then force-close the stream.
        wrapUpTimer = setTimeout(() => {
          if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
          logger.warn('voice.realtime.wrap_up_warning', { callSid });
          openaiWs.send(JSON.stringify({
            type: 'conversation.item.create',
            item: {
              type: 'message',
              role: 'system',
              content: [{ type: 'input_text', text: 'TIME LIMIT REACHED: end the call NOW in one short sentence. If you have their info, confirm someone will follow up. Say goodbye warmly.' }],
            },
          }));
          openaiWs.send(JSON.stringify({ type: 'response.create' }));
        }, MAX_CALL_MS - 45_000);
        hardStopTimer = setTimeout(() => {
          logger.warn('voice.realtime.max_duration', { callSid });
          try { if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close(); } catch {}
          try { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); } catch {}
          if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
        }, MAX_CALL_MS);
        break;
      }

      case 'media': {
        // Forward caller audio to OpenAI.
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
          openaiWs.send(JSON.stringify({
            type: 'input_audio_buffer.append',
            audio: msg.media.payload,
          }));
        }
        break;
      }

      case 'stop': {
        logger.info('voice.realtime.stream_stopped', { callSid });
        sendDbgTrace();
        clearTimeout(wrapUpTimer);
        clearTimeout(hardStopTimer);
        if (drainTimer) { clearInterval(drainTimer); drainTimer = null; }
        if (callSid) await updateCall(callSid, { outcome: 'ai_handled' }).catch(() => {});
        if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();

        // Notify tenant — distinguish completed (lead captured) vs aborted (hung up mid-call).
        if (tenant) {
          const notifyTo = tenant.voicemail_email || tenant.owner_email;
          if (notifyTo) {
            const ts = new Date().toLocaleString('en-US', {
              timeZone: tenant.timezone || 'America/Los_Angeles',
              dateStyle: 'medium',
              timeStyle: 'short',
            });
            const subject = leadCaptured
              ? `✅ Call completed — ${tenant.business_name}`
              : `⚠️ Call aborted — ${tenant.business_name}`;
            const transcriptHtml = transcript.length
              ? `<hr/><h3>Transcript</h3><pre style="font-family:monospace;font-size:13px;line-height:1.5">${transcript.map(l => `${l.role === 'ai' ? '🤖 AI' : '👤 Caller'}: ${l.text}`).join('\n')}</pre>`
              : '';
            const html = leadCaptured
              ? `<p>The caller from <strong>${fromNumber || 'unknown'}</strong> completed the conversation and their info was captured.</p><p><strong>Time:</strong> ${ts}</p>${transcriptHtml}`
              : `<p>The caller from <strong>${fromNumber || 'unknown'}</strong> hung up mid-conversation before leaving their info.</p><p><strong>Time:</strong> ${ts}</p>${transcriptHtml}`;
            sendEmail({ to: notifyTo, subject, html }).catch(() => {});

            // Save transcript to DB.
            if (callSid && transcript.length) {
              const transcriptText = transcript.map(l => `${l.role === 'ai' ? 'AI' : 'Caller'}: ${l.text}`).join('\n');
              updateCall(callSid, { transcript: transcriptText }).catch(() => {});
            }
          }

          // Telegram notification
          const tgToken = process.env.TELEGRAM_BOT_TOKEN;
          const tgChatId = process.env.TELEGRAM_CHAT_ID || '6335227029';
          logger.info('voice.telegram.attempt', { hasToken: !!tgToken, chatId: tgChatId });
          if (tgToken) {
            const header = leadCaptured ? '✅ Lead captured' : '⚠️ Call ended — no lead';
            const callType = isCallback ? ' (callback)' : '';
            const lines = [`📞 ${header}${callType}`, `From: ${fromNumber || 'unknown'}`, `Business: ${tenant.business_name}`];
            if (transcript.length) {
              lines.push('', 'Transcript:');
              lines.push(...transcript.map(l => `${l.role === 'ai' ? '🤖' : '👤'} ${l.text}`));
            }
            const tgText = lines.join('\n').slice(0, 4000);
            fetch(`https://api.telegram.org/bot${tgToken}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: tgChatId, text: tgText }),
            }).then(r => r.json()).then(j => {
              if (!j.ok) logger.error('voice.telegram.api_error', { code: j.error_code, description: j.description });
              else logger.info('voice.telegram.sent', { messageId: j.result?.message_id });
            }).catch(err => logger.error('voice.telegram.failed', { error: err.message }));
          }

          // Schedule callback if no lead was captured and this was not already a callback.
          // Gated by CALLBACK_ENABLED (set to 'false' to disable, e.g. during testing
          // so hang-up test calls don't trigger ghost callbacks).
          if (process.env.CALLBACK_ENABLED === 'true' && !leadCaptured && !isCallback && fromNumber && fromNumber !== 'anonymous') {
            const baseUrl = (process.env.APP_BASE_URL || 'https://socal-receptionist-v2-spbrw.ondigitalocean.app').replace(/\/+$/, '');
            const callbackFrom = ourNumber || '+19513958776';
            setTimeout(() => {
              twilioClient.calls.create({
                to: fromNumber,
                from: callbackFrom,
                url: `${baseUrl}/voice/callback`,
              }).catch(err => logger.error('voice.callback.create_failed', { error: err.message }));
            }, 30000);
            logger.info('voice.callback.scheduled', { to: fromNumber, from: callbackFrom });
          }
        }
        break;
      }
    }
  });

  twilioWs.on('close', () => {
    logger.info('voice.realtime.twilio_closed');
    sendDbgTrace();
    clearTimeout(wrapUpTimer);
    clearTimeout(hardStopTimer);
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on('error', (err) => {
    logger.error('voice.realtime.twilio_ws_error', { error: err.message });
  });
}

module.exports = { handleMediaStream };
