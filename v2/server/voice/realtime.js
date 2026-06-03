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
      case 'response.audio.delta': {
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
        modalities: ['audio', 'text'],
        voice: realtimeVoice,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: {
          type: 'server_vad',
          threshold: 0.6,
          prefix_padding_ms: 300,
          silence_duration_ms: 400,
          create_response: true,
        },
        instructions,
        tools: buildTools(tenant),
        tool_choice: 'auto',
      },
    }));

    // Trigger the AI to greet the caller.
    openaiWs.send(JSON.stringify({
      type: 'response.create',
      response: {
        instructions: tenant.voice_greeting
          ? `Say this greeting exactly: "${tenant.voice_greeting}"`
          : `Greet the caller by saying "Thank you for calling ${tenant.business_name}," then ask how you can help. One sentence. Do not mention AI or virtual receptionist.`,
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
        twilioClient.calls(callSid).update({
          twiml: `<Response><Say voice="${tenant.voice_id || 'Polly.Joanna-Neural'}">One moment while I connect you with our team.</Say><Dial timeout="20" action="https://socal-receptionist-v2-spbrw.ondigitalocean.app/voice/dial-status">${staffPhone}</Dial></Response>`,
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
