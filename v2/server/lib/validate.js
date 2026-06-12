// Validation for tenant-supplied config fields (audit item: no input
// validation on phone/timezone at registration).

// E.164-ish phone validation. Accepts common human formatting and returns the
// normalized +E.164 string, or null if invalid. Bare 10-digit numbers are
// assumed US (+1) since the product is US-only today.
function normalizePhone(input) {
  if (typeof input !== 'string') return null;
  const cleaned = input.trim().replace(/[\s().-]/g, '');
  if (!cleaned) return null;
  if (/^\+[1-9]\d{7,14}$/.test(cleaned)) return cleaned;
  if (/^[2-9]\d{9}$/.test(cleaned)) return '+1' + cleaned;
  if (/^1[2-9]\d{9}$/.test(cleaned)) return '+' + cleaned;
  return null;
}

// IANA timezone check — Intl throws RangeError on unknown zones.
function isValidTimezone(tz) {
  if (typeof tz !== 'string' || !tz.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() });
    return true;
  } catch {
    return false;
  }
}

function isValidEmail(email) {
  return (
    typeof email === 'string' &&
    email.trim().length <= 254 &&
    /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())
  );
}

module.exports = { normalizePhone, isValidTimezone, isValidEmail };
