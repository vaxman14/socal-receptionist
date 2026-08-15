const test = require('node:test');
const assert = require('node:assert/strict');

const { synthesizeHebrew, buildSsml } = require('../server/voice/azure-tts');

test('buildSsml uses Avri and escapes model text', () => {
  const ssml = buildSsml('שלום <עולם> & "חברים"');
  assert.match(ssml, /voice name="he-IL-AvriNeural"/);
  assert.match(ssml, /שלום &lt;עולם&gt; &amp; &quot;חברים&quot;/);
});

test('synthesizeHebrew requests raw PCM16 at 24kHz and returns the bytes', async () => {
  const expected = Buffer.from([0, 0, 1, 0, 2, 0]);
  let request;
  const fetchImpl = async (url, options) => {
    request = { url, options };
    return { ok: true, arrayBuffer: async () => expected };
  };

  const pcm = await synthesizeHebrew('שלום', {
    key: 'test-key',
    region: 'eastus',
    fetchImpl,
  });

  assert.equal(request.url, 'https://eastus.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(request.options.headers['X-Microsoft-OutputFormat'], 'raw-24khz-16bit-mono-pcm');
  assert.equal(request.options.headers['Ocp-Apim-Subscription-Key'], 'test-key');
  assert.deepEqual(pcm, expected);
});
