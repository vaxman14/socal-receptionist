// Telephony audio path helpers — the known-good baseline:
//   OpenAI Realtime outputs PCM16 @ 24kHz -> downsample to 8kHz (average of 3
//   samples) -> G.711 mu-law encode -> paced to Twilio in 20ms (160-byte)
//   frames on a wall-clock-corrected schedule.
//
// Asking OpenAI for audio/pcmu directly produced garbled "wind/roar" audio
// (PCM bytes played as mu-law); we own the transcode end to end instead.
//
// Pure module: no env, no network — testable without secrets.

const FRAME_BYTES = 160; // 20ms of 8kHz G.711 mu-law

function linearToMulaw(sample) {
  const BIAS = 0x84;
  const CLIP = 32635;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > CLIP) sample = CLIP;
  sample += BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  const mantissa = (sample >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

// Stateful base64-PCM16@24k -> mu-law@8k transcoder. Deltas arrive at
// arbitrary byte boundaries, so leftover bytes (a partial 3-sample group, or a
// split int16) carry over to the next push.
function createPcmToMulawTranscoder() {
  let remainder = Buffer.alloc(0);
  return {
    push(b64) {
      const buf = Buffer.concat([remainder, Buffer.from(b64, 'base64')]);
      const samples = Math.floor(buf.length / 2);
      const groups = Math.floor(samples / 3);
      const out = Buffer.alloc(groups);
      for (let g = 0; g < groups; g++) {
        const i = g * 6;
        const avg = ((buf.readInt16LE(i) + buf.readInt16LE(i + 2) + buf.readInt16LE(i + 4)) / 3) | 0;
        out[g] = linearToMulaw(avg);
      }
      remainder = buf.subarray(groups * 6);
      return out;
    },
    reset() {
      remainder = Buffer.alloc(0);
    },
  };
}

// Wall-clock-corrected pacing: setInterval(20) never fires at exactly 20ms
// (timer drift + event-loop load under the OpenAI WS), so a naive
// one-frame-per-tick drain falls behind real time and starves -> a periodic
// stutter/gap. Each tick we take as many 20ms frames as the real elapsed time
// calls for. Returns { frames, queue, nextFrameAt }; the caller resets
// nextFrameAt to "now" whenever the queue runs dry.
function takeDueFrames(queue, nextFrameAt, now, frameBytes = FRAME_BYTES) {
  const frames = [];
  while (queue.length >= frameBytes && nextFrameAt <= now) {
    const frame = queue.subarray(0, frameBytes);
    queue = queue.subarray(frameBytes);
    frames.push(frame);
    nextFrameAt += 20;
  }
  return { frames, queue, nextFrameAt };
}

// A partial frame is valid only when the response/stream has explicitly ended.
// Pad with mu-law silence so Twilio still receives one complete 20ms timing slot.
function flushFinalFrame(queue, frameBytes = FRAME_BYTES) {
  if (!queue.length) return Buffer.alloc(0);
  if (queue.length >= frameBytes) return queue.subarray(0, frameBytes);
  const frame = Buffer.alloc(frameBytes, 0xff);
  queue.copy(frame);
  return frame;
}

module.exports = { FRAME_BYTES, linearToMulaw, createPcmToMulawTranscoder, takeDueFrames, flushFinalFrame };
