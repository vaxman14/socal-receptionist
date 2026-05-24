// Transcribes a Twilio recording URL using Groq's whisper-large-v3 model.
// Call this as a drop-in for Twilio's built-in <Gather input="speech">.
//
// Twilio recordings are behind basic auth. We fetch the .mp3, build a
// multipart upload, and POST to Groq's OpenAI-compatible transcription API.

const config = require('./config');

async function transcribe(recordingUrl) {
  if (!config.groq.apiKey) return '';

  const url = recordingUrl.endsWith('.mp3') ? recordingUrl : `${recordingUrl}.mp3`;
  const creds = Buffer.from(
    `${config.twilio.accountSid}:${config.twilio.authToken}`
  ).toString('base64');

  let audioBytes;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const resp = await fetch(url, { headers: { Authorization: `Basic ${creds}` } });
    if (resp.ok) {
      audioBytes = Buffer.from(await resp.arrayBuffer());
      break;
    }
    if (attempt < 3) await new Promise(r => setTimeout(r, 600 * attempt));
    else throw new Error(`Recording fetch failed (${resp.status}) after 3 tries`);
  }

  const boundary = `boundary${Date.now()}`;
  const nl = '\r\n';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="model"${nl}${nl}whisper-large-v3${nl}`),
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="language"${nl}${nl}en${nl}`),
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="response_format"${nl}${nl}json${nl}`),
    Buffer.from(`--${boundary}${nl}Content-Disposition: form-data; name="file"; filename="audio.mp3"${nl}Content-Type: audio/mpeg${nl}${nl}`),
    audioBytes,
    Buffer.from(`${nl}--${boundary}--${nl}`),
  ]);

  const whisperResp = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.groq.apiKey}`,
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    body,
  });

  if (!whisperResp.ok) {
    const err = await whisperResp.text();
    throw new Error(`Groq Whisper ${whisperResp.status}: ${err.slice(0, 200)}`);
  }

  const data = await whisperResp.json();
  return (data.text || '').trim();
}

module.exports = { transcribe };
