// Voice preview endpoint — returns a short audio sample for each Polly voice.
//
// Uses OpenAI TTS (already configured via OPENAI_API_KEY) to approximate each
// Polly voice. The mapping is gender/accent-matched, not an exact clone — good
// enough to give clients a feel for the voice before they commit.
//
// Audio is generated on first request per voice and cached in memory for the
// lifetime of the process (~50 KB per clip, 8 voices = ~400 KB total).

const express = require('express');
const OpenAI = require('openai');
const { requireAuth } = require('../lib/auth');

const router = express.Router();
router.use(requireAuth);

const SAMPLE_TEXT = 'Thank you for calling. How can I help you today?';

// Closest OpenAI voice for each Polly neural voice.
const VOICE_MAP = {
  'Polly.Joanna-Neural':  'nova',     // US female, warm
  'Polly.Ruth-Neural':    'shimmer',  // US female, clear
  'Polly.Kendra-Neural':  'nova',     // US female, friendly
  'Polly.Salli-Neural':   'alloy',    // US female, upbeat
  'Polly.Matthew-Neural': 'onyx',     // US male, authoritative
  'Polly.Stephen-Neural': 'echo',     // US male, conversational
  'Polly.Amy-Neural':     'fable',    // British female
  'Polly.Brian-Neural':   'fable',    // British male (closest available)
};

// In-memory cache: voiceId → Buffer
const cache = new Map();

let _openai;
function openaiClient() {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
}

router.get('/voice-preview/:voiceId', async (req, res) => {
  const voiceId = req.params.voiceId;
  const oaiVoice = VOICE_MAP[voiceId];
  if (!oaiVoice) {
    return res.status(404).json({ error: 'unknown voice id' });
  }

  if (cache.has(voiceId)) {
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    return res.send(cache.get(voiceId));
  }

  try {
    const response = await openaiClient().audio.speech.create({
      model: 'tts-1',
      voice: oaiVoice,
      input: SAMPLE_TEXT,
      response_format: 'mp3',
    });
    const buf = Buffer.from(await response.arrayBuffer());
    cache.set(voiceId, buf);
    res.set('Content-Type', 'audio/mpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) {
    console.error('[voice-preview] TTS failed:', err.message);
    res.status(502).json({ error: 'could not generate preview' });
  }
});

module.exports = router;
