const SECRET = process.env.RECAPTCHA_SECRET_KEY;
const MIN_SCORE = 0.5;

async function verifyRecaptcha(token) {
  if (!SECRET) return { ok: true, skipped: true };
  if (!token) return { ok: false, reason: 'missing token' };

  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: SECRET, response: token }),
  });
  const data = await res.json();

  if (!data.success) return { ok: false, reason: 'verification failed' };
  if (data.score < MIN_SCORE) return { ok: false, reason: 'low score', score: data.score };
  return { ok: true, score: data.score };
}

module.exports = { verifyRecaptcha };
