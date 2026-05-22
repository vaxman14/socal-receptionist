// MFA trusted-device API.
//
// Mounted at /auth/mfa. The TOTP and passkey factors themselves are handled
// entirely by Supabase Auth from the browser (supabase.auth.mfa.*); this module
// only owns the app-side "trust this device for 30 days" feature.
//
// Flow:
//   * After a user clears the MFA challenge at sign-in with "trust this device"
//     ticked, the frontend POSTs /auth/mfa/trust. The backend mints a signed
//     HMAC token (MFA_TOKEN_SECRET), records its SHA-256 hash in
//     trusted_devices, and returns the raw token — the browser stores it in
//     localStorage.
//   * On the next sign-in the frontend POSTs the stored token to
//     /auth/mfa/verify-device BEFORE prompting for a code. A valid, unexpired,
//     non-revoked token tells the SPA it may skip the MFA challenge.
//   * Settings lists trusted devices (GET /) and revokes them (DELETE /:id).
//
// The token format is `<deviceId>.<base64url(hmac)>`. Only the hash is stored,
// so a database leak cannot forge a trusted session — an attacker would still
// need MFA_TOKEN_SECRET to produce a valid signature.

const express = require('express');
const crypto = require('crypto');
const { supabase } = require('../lib/supabase');
const { requireAuth } = require('../lib/auth');

const router = express.Router();

// Trust window — keep in sync with the "30 days" copy on the MFA screen.
const TRUST_TTL_DAYS = 30;

// The HMAC secret is read lazily (not at module load) so the service still
// boots in dev when MFA_TOKEN_SECRET is unset — only the endpoints below fail,
// loudly, if a user actually tries to use them.
function mfaSecret() {
  const secret = process.env.MFA_TOKEN_SECRET;
  if (!secret) {
    const err = new Error('MFA_TOKEN_SECRET is not configured');
    err.code = 'mfa_not_configured';
    throw err;
  }
  return secret;
}

// Sign a device id into an opaque token. The signature covers the id, so the
// id cannot be swapped without invalidating the token.
function signToken(deviceId) {
  const sig = crypto
    .createHmac('sha256', mfaSecret())
    .update(deviceId)
    .digest('base64url');
  return `${deviceId}.${sig}`;
}

// Constant-time verify of a token's signature. Returns the device id or null.
function unsignToken(token) {
  if (typeof token !== 'string' || !token.includes('.')) return null;
  const idx = token.lastIndexOf('.');
  const deviceId = token.slice(0, idx);
  const presented = token.slice(idx + 1);
  let expected;
  try {
    expected = crypto.createHmac('sha256', mfaSecret()).update(deviceId).digest('base64url');
  } catch {
    return null;
  }
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return deviceId;
}

// SHA-256 hash stored in the DB — the raw token never lands in Postgres.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Best-effort, human-friendly label from a User-Agent string.
function labelFromUserAgent(ua) {
  if (!ua) return 'Unknown device';
  const os =
    /Windows/i.test(ua) ? 'Windows' :
    /Mac OS X|Macintosh/i.test(ua) ? 'macOS' :
    /iPhone|iPad|iOS/i.test(ua) ? 'iOS' :
    /Android/i.test(ua) ? 'Android' :
    /Linux/i.test(ua) ? 'Linux' : 'device';
  const browser =
    /Edg\//i.test(ua) ? 'Edge' :
    /Chrome\//i.test(ua) ? 'Chrome' :
    /Firefox\//i.test(ua) ? 'Firefox' :
    /Safari\//i.test(ua) ? 'Safari' : 'browser';
  return `${browser} on ${os}`;
}

router.use(requireAuth);

// POST /auth/mfa/trust — issue a 30-day device-trust token for the caller.
// Called after the user clears the MFA challenge with "trust this device" on.
// Requires the session to be at AAL2 (the caller just passed a factor).
router.post('/trust', async (req, res) => {
  try {
    const userAgent = req.header('user-agent') || null;
    const label =
      (typeof req.body.label === 'string' && req.body.label.trim()) ||
      labelFromUserAgent(userAgent);

    // Create the row first so we have a uuid to sign into the token.
    const expiresAt = new Date(Date.now() + TRUST_TTL_DAYS * 24 * 60 * 60 * 1000);
    const { data, error } = await supabase
      .from('trusted_devices')
      .insert({
        user_id: req.user.id,
        token_hash: 'pending', // replaced below — unique column needs a placeholder
        label,
        user_agent: userAgent,
        expires_at: expiresAt.toISOString(),
      })
      .select('id')
      .single();
    if (error) throw error;

    const token = signToken(data.id);
    const { error: updateError } = await supabase
      .from('trusted_devices')
      .update({ token_hash: hashToken(token) })
      .eq('id', data.id);
    if (updateError) throw updateError;

    res.json({ token, expiresAt: expiresAt.toISOString(), trustDays: TRUST_TTL_DAYS });
  } catch (err) {
    if (err.code === 'mfa_not_configured') {
      console.error('[mfa] trust failed: MFA_TOKEN_SECRET unset');
      return res.status(503).json({ error: 'MFA is not configured on this server' });
    }
    console.error('[mfa] trust failed:', err.message);
    res.status(500).json({ error: 'could not register trusted device' });
  }
});

// POST /auth/mfa/verify-device — does the caller's stored token still grant
// trust? Called at the start of sign-in to decide whether to skip the MFA
// challenge. { trusted: true } means skip; false means challenge as normal.
router.post('/verify-device', async (req, res) => {
  try {
    const token = req.body.token;
    if (!token) return res.json({ trusted: false });

    const deviceId = unsignToken(token);
    if (!deviceId) return res.json({ trusted: false }); // bad / forged signature

    const { data, error } = await supabase
      .from('trusted_devices')
      .select('id, user_id, token_hash, expires_at')
      .eq('id', deviceId)
      .maybeSingle();
    if (error) throw error;

    // Must exist, belong to the caller, hash-match, and not be expired.
    const valid =
      data &&
      data.user_id === req.user.id &&
      data.token_hash === hashToken(token) &&
      new Date(data.expires_at).getTime() > Date.now();

    if (!valid) return res.json({ trusted: false });

    // Bump last_seen_at so Settings shows recency (best-effort, non-fatal).
    await supabase
      .from('trusted_devices')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', data.id);

    res.json({ trusted: true });
  } catch (err) {
    if (err.code === 'mfa_not_configured') {
      // No secret means no trusted device can be valid — fail closed (challenge).
      return res.json({ trusted: false });
    }
    console.error('[mfa] verify-device failed:', err.message);
    res.status(500).json({ error: 'could not verify trusted device' });
  }
});

// GET /auth/mfa/devices — the caller's trusted devices, newest first. Expired
// rows are swept here so the list only ever shows live grants.
router.get('/devices', async (req, res) => {
  try {
    await supabase
      .from('trusted_devices')
      .delete()
      .eq('user_id', req.user.id)
      .lt('expires_at', new Date().toISOString());

    const { data, error } = await supabase
      .from('trusted_devices')
      .select('id, label, user_agent, created_at, last_seen_at, expires_at')
      .eq('user_id', req.user.id)
      .order('created_at', { ascending: false });
    if (error) throw error;

    res.json({ devices: data });
  } catch (err) {
    console.error('[mfa] list devices failed:', err.message);
    res.status(500).json({ error: 'could not load trusted devices' });
  }
});

// DELETE /auth/mfa/devices/:id — revoke one trusted device. Scoped to the
// caller's user_id so a token id alone cannot revoke someone else's device.
router.delete('/devices/:id', async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('trusted_devices')
      .delete()
      .eq('id', req.params.id)
      .eq('user_id', req.user.id) // scope guard
      .select('id');
    if (error) throw error;
    if (!data || !data.length) {
      return res.status(404).json({ error: 'trusted device not found' });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error('[mfa] revoke device failed:', err.message);
    res.status(500).json({ error: 'could not revoke trusted device' });
  }
});

module.exports = router;
