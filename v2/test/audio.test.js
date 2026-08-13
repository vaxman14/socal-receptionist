// The known-good audio baseline: OpenAI outputs PCM16 @ 24kHz, we downsample
// to 8kHz (average of 3 samples), mu-law encode with remainder carry between
// deltas, and pace 160-byte (20ms) frames to Twilio on a wall-clock schedule.

const test = require('node:test');
const assert = require('node:assert/strict');

const audio = require('../server/voice/audio');

test('FRAME_BYTES is 20ms of 8kHz G.711 mu-law', () => {
  assert.equal(audio.FRAME_BYTES, 160);
});

test('linearToMulaw known values', () => {
  assert.equal(audio.linearToMulaw(0), 0xff);        // silence
  assert.equal(audio.linearToMulaw(32767), 0x80);    // positive clip
  assert.equal(audio.linearToMulaw(-32768), 0x00);   // negative clip
  // Symmetry: mu-law of -x differs from x only in the sign bit.
  const pos = audio.linearToMulaw(1000);
  const neg = audio.linearToMulaw(-1000);
  assert.equal(pos & 0x7f, neg & 0x7f);
  assert.notEqual(pos & 0x80, neg & 0x80);
});

function pcmBuf(samples) {
  const b = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => b.writeInt16LE(s, i * 2));
  return b;
}

test('transcoder: 3 input samples average into 1 mu-law byte', () => {
  const t = audio.createPcmToMulawTranscoder();
  const out = t.push(pcmBuf([0, 0, 0, 3000, 3000, 3000]).toString('base64'));
  assert.equal(out.length, 2);
  assert.equal(out[0], audio.linearToMulaw(0));
  assert.equal(out[1], audio.linearToMulaw(3000));
});

test('transcoder: remainder carries across deltas — chunked equals whole', () => {
  // 100 samples of a deterministic ramp, split at awkward (odd) byte offsets.
  const samples = Array.from({ length: 100 }, (_, i) => (i * 613) % 20000 - 10000);
  const whole = pcmBuf(samples);

  const one = audio.createPcmToMulawTranscoder();
  const single = one.push(whole.toString('base64'));

  const two = audio.createPcmToMulawTranscoder();
  const chunks = [whole.subarray(0, 7), whole.subarray(7, 50), whole.subarray(50, 51), whole.subarray(51)];
  const rejoined = Buffer.concat(chunks.map((c) => two.push(c.toString('base64'))));

  assert.equal(single.length, Math.floor(100 / 3));
  assert.deepEqual(rejoined, single);
});

test('transcoder: reset drops the carried remainder', () => {
  const t = audio.createPcmToMulawTranscoder();
  t.push(pcmBuf([500, 500]).toString('base64')); // 2 samples — all remainder
  t.reset();
  const out = t.push(pcmBuf([0, 0, 0]).toString('base64'));
  assert.equal(out.length, 1);
  assert.equal(out[0], audio.linearToMulaw(0)); // old 500s were discarded
});

test('takeDueFrames: sends exactly the frames the elapsed wall clock calls for', () => {
  const queue = Buffer.alloc(160 * 5, 0x55);
  // 60ms elapsed since the first frame was due -> 4 frames due (t0, +20, +40, +60).
  const r = audio.takeDueFrames(queue, 1000, 1060);
  assert.equal(r.frames.length, 4);
  r.frames.forEach((f) => assert.equal(f.length, 160));
  assert.equal(r.queue.length, 160);
  assert.equal(r.nextFrameAt, 1080);
});

test('takeDueFrames: nothing due yet, or queue exhausted mid-catchup', () => {
  const none = audio.takeDueFrames(Buffer.alloc(320), 2000, 1990);
  assert.equal(none.frames.length, 0);
  assert.equal(none.queue.length, 320);
  assert.equal(none.nextFrameAt, 2000);

  // Only 2 frames queued but 5 are due — drain what exists, clock advances per frame sent.
  const short = audio.takeDueFrames(Buffer.alloc(320), 1000, 1100);
  assert.equal(short.frames.length, 2);
  assert.equal(short.queue.length, 0);
  assert.equal(short.nextFrameAt, 1040);
});

test('takeDueFrames: trailing partial frame is retained during continuous draining', () => {
  const r = audio.takeDueFrames(Buffer.alloc(200, 1), 1000, 1040);
  assert.equal(r.frames.length, 1);
  assert.equal(r.frames[0].length, 160);
  assert.equal(r.queue.length, 40);
});

test('flushFinalFrame explicitly pads only a final partial frame', () => {
  assert.equal(audio.flushFinalFrame(Buffer.alloc(0)).length, 0);
  const frame = audio.flushFinalFrame(Buffer.alloc(40, 1));
  assert.equal(frame.length, 160);
  assert.ok(frame.subarray(0, 40).every((b) => b === 1));
  assert.ok(frame.subarray(40).every((b) => b === 0xff));
});
