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

const REALTIME_MODEL = 'gpt-realtime-2';
const OPENAI_WS_URL = `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`;

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

      // Forward AI audio deltas back to Twilio.
      case 'response.output_audio.delta': {
        if (streamSid && event.delta) {
          twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid,
            media: { payload: event.delta },
          }));
        }
        break;
      }

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
        if (event.transcript) transcript.push({ role: 'caller', text: event.transcript.trim() });
        break;
      }

      // AI speech transcription.
      case 'response.audio_transcript.done': {
        if (event.transcript) transcript.push({ role: 'ai', text: event.transcript.trim() });
        break;
      }

      case 'error': {
        logger.error('voice.realtime.openai_error', { error: event.error });
        break;
      }
    }
  });

  openaiWs.on('close', () => logger.info('voice.realtime.openai_closed'));
  openaiWs.on('error', (err) => logger.error('voice.realtime.openai_ws_error', { error: err.message }));

  function configureSession() {
    if (!openaiWs || openaiWs.readyState !== WebSocket.OPEN) return;
    const realtimeVoice = POLLY_TO_REALTIME[tenant.voice_id] || 'marin';
    const instructions = buildSystemPrompt(tenant, { channel: 'voice', callerPhone: fromNumber });
    openaiWs.send(JSON.stringify({
      type: 'session.update',
      session: {
        type: 'realtime',
        output_modalities: ['audio'],
        audio: {
          input: {
            format: { type: 'audio/pcmu' },
            turn_detection: { type: 'server_vad', threshold: 0.8, prefix_padding_ms: 300, silence_duration_ms: 1500, create_response: true },
          },
          output: {
            format: { type: 'audio/pcmu' },
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
          if (!leadCaptured && !isCallback && fromNumber && fromNumber !== 'anonymous') {
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
    if (openaiWs && openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
  });

  twilioWs.on('error', (err) => {
    logger.error('voice.realtime.twilio_ws_error', { error: err.message });
  });
}

module.exports = { handleMediaStream };
