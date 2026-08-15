'use strict';

const DEFAULT_VOICE = 'he-IL-AvriNeural';
const OUTPUT_FORMAT = 'raw-24khz-16bit-mono-pcm';

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function buildSsml(text, voice = DEFAULT_VOICE) {
  return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="he-IL"><voice name="${xmlEscape(voice)}"><prosody rate="-3%">${xmlEscape(text)}</prosody></voice></speak>`;
}

function isAzureHebrewConfigured(tenant) {
  const settings = (tenant && tenant.voice_settings) || {};
  return settings.tts_provider_he === 'azure' &&
    !!process.env.AZURE_SPEECH_KEY &&
    !!process.env.AZURE_SPEECH_REGION;
}

async function synthesizeHebrew(text, {
  key = process.env.AZURE_SPEECH_KEY,
  region = process.env.AZURE_SPEECH_REGION,
  voice = DEFAULT_VOICE,
  fetchImpl = fetch,
  signal,
} = {}) {
  if (!text || !String(text).trim()) throw new Error('Hebrew speech text is required');
  if (!key || !region) throw new Error('Azure Speech is not configured');

  const response = await fetchImpl(
    `https://${region}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': OUTPUT_FORMAT,
        'User-Agent': 'SoCal-Receptionist-Israel/1.0',
      },
      body: buildSsml(text, voice),
      signal,
    }
  );
  if (!response.ok) throw new Error(`Azure Speech returned HTTP ${response.status}`);

  const pcm = Buffer.from(await response.arrayBuffer());
  if (!pcm.length || pcm.length % 2 !== 0) throw new Error('Azure Speech returned invalid PCM16 audio');
  return pcm;
}

module.exports = {
  DEFAULT_VOICE,
  OUTPUT_FORMAT,
  buildSsml,
  isAzureHebrewConfigured,
  synthesizeHebrew,
};
