# OpenAI Realtime API — SoCal Receptionist V2

Last verified: 2026-06-03

## What Works (DO NOT CHANGE WITHOUT READING THIS)

### Model
`gpt-realtime-2` — this is the correct model for Roman's OpenAI account.
NOT `gpt-4o-realtime-preview` (model_not_found on this account).

### WebSocket Connection
```js
const ws = new WebSocket('wss://api.openai.com/v1/realtime?model=gpt-realtime-2', {
  headers: {
    Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
    // DO NOT add OpenAI-Beta: realtime=v1 — routes to dead beta endpoint
  },
});
```

### session.update format
```js
{
  type: 'session.update',
  session: {
    type: 'realtime',           // REQUIRED — do not remove
    output_modalities: ['audio'], // NOT 'modalities'
    audio: {
      input: {
        format: { type: 'audio/pcmu' },  // Twilio sends G.711 mulaw
        turn_detection: { type: 'semantic_vad' },
      },
      output: {
        format: { type: 'audio/pcmu' },
        voice: 'marin',  // or cedar
      },
    },
    instructions: SYSTEM_PROMPT,
    tools: [...],
    tool_choice: 'auto',
  },
}
```

### Audio event name (GA)
`response.output_audio.delta` — NOT `response.audio.delta`

### DO app
`8c3788c6-828f-46f8-a908-b1873d57001f` (socal-receptionist-v2)

### OpenAI API key
Set as `OPENAI_API_KEY` secret in DO app env.
Current key added: 2026-06-03 (sk-proj-SG9bn...)

## History of bugs fixed 2026-06-03
1. Model was `gpt-realtime-2` (correct) → wrongly changed to `gpt-4o-realtime-preview` → changed back
2. `type: 'realtime'` inside session was removed → added back (REQUIRED)
3. `modalities` removed — not supported, use `output_modalities`
4. `OpenAI-Beta: realtime=v1` header added → removed (kills connection)
5. Audio event `response.audio.delta` → fixed to `response.output_audio.delta`
6. session used flat `input_audio_format/output_audio_format` → rewritten to nested `audio.input/output`
7. Email FROM was `noreply@socalreceptionist.com` (unverified) → fixed to `hello@noreply.socalreceptionist.com`
