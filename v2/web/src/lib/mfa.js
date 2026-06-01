// MFA helpers shared by the login challenge screen and Settings.
//
// Two layers sit behind these functions:
//   * Supabase Auth — owns the TOTP + passkey factors themselves
//     (supabase.auth.mfa.*). The browser talks to it directly.
//   * The V2 backend (/auth/mfa/*) — owns the "trust this device for 30 days"
//     ledger. A trust token is kept in localStorage and presented at sign-in.

import { supabase } from './supabase';
import { api } from './api';

// localStorage key for this browser's device-trust token. The token is opaque
// (HMAC-signed by the backend) and only meaningful to /auth/mfa/verify-device.
const TRUST_KEY = 'scr.mfa.trust';

export function getTrustToken() {
  try {
    return localStorage.getItem(TRUST_KEY) || null;
  } catch {
    return null; // private mode / storage disabled
  }
}

export function setTrustToken(token) {
  try {
    if (token) localStorage.setItem(TRUST_KEY, token);
    else localStorage.removeItem(TRUST_KEY);
  } catch {
    /* storage disabled — trust simply won't persist */
  }
}

export function clearTrustToken() {
  setTrustToken(null);
}

// --- Assurance level --------------------------------------------------------

// Does the current session need to clear an MFA challenge before it is fully
// authenticated? Returns { needed, currentLevel, nextLevel }.
//   currentLevel 'aal1' + nextLevel 'aal2'  => user has a verified factor and
//                                              must still complete it.
export async function getMfaStatus() {
  const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
  if (error || !data) return { needed: false, currentLevel: null, nextLevel: null };
  return {
    needed: data.currentLevel === 'aal1' && data.nextLevel === 'aal2',
    currentLevel: data.currentLevel,
    nextLevel: data.nextLevel,
  };
}

// --- TOTP (authenticator app) ----------------------------------------------

// List the user's MFA factors, split by type. Verified factors only, except
// `allTotp` which includes unverified ones (so a stale enroll can be cleaned).
export async function listFactors() {
  const { data, error } = await supabase.auth.mfa.listFactors();
  if (error) throw error;
  return {
    totp: data.totp || [],
    phone: data.phone || [],
    // Passkeys come back under `all` with factor_type 'webauthn'.
    webauthn: (data.all || []).filter((f) => f.factor_type === 'webauthn'),
    all: data.all || [],
  };

}

// Begin a phone (SMS OTP) enrollment. Returns { factorId, phone }.
export async function enrollPhone(phone) {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'phone',
    phone,
  });
  if (error) throw error;
  return { factorId: data.id, phone };
}

// Challenge a phone factor — sends the SMS. Returns { challengeId }.
export async function challengePhone(factorId) {
  const { data, error } = await supabase.auth.mfa.challenge({ factorId });
  if (error) throw error;
  return { challengeId: data.id };
}

// Begin a TOTP enrollment. Returns { factorId, qrSvg, secret, uri }.
export async function enrollTotp(friendlyName) {
  const { data, error } = await supabase.auth.mfa.enroll({
    factorType: 'totp',
    friendlyName: friendlyName || `Authenticator ${new Date().toLocaleDateString()}`,
  });
  if (error) throw error;
  return {
    factorId: data.id,
    qrSvg: data.totp.qr_code, // a data: URI of an SVG QR code
    secret: data.totp.secret, // the base32 secret, for manual entry
    uri: data.totp.uri,
  };
}

// Verify a 6-digit code against a factor — used both to finish enrollment and
// to clear a sign-in challenge. challengeAndVerify does the challenge step for
// us, so callers only pass the code.
export async function verifyFactor(factorId, code) {
  const { data, error } = await supabase.auth.mfa.challengeAndVerify({
    factorId,
    code: String(code).replace(/\s/g, ''),
  });
  if (error) throw error;
  return data;
}

// Remove a factor (TOTP or passkey).
export async function unenrollFactor(factorId) {
  const { error } = await supabase.auth.mfa.unenroll({ factorId });
  if (error) throw error;
}

// --- Passkeys (WebAuthn) ----------------------------------------------------

// Whether this browser can do WebAuthn at all. The Settings UI also has to
// account for the Supabase project not having the webauthn factor enabled —
// that surfaces as an error from registerPasskey() and is handled there.
export function browserSupportsPasskeys() {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    !!supabase.auth.mfa.webauthn
  );
}

// Register a passkey for the signed-in user. Runs the full WebAuthn ceremony
// (navigator.credentials.create) via supabase-js. Throws on failure — including
// when the Supabase project does not have WebAuthn factors enabled.
export async function registerPasskey(friendlyName) {
  if (!supabase.auth.mfa.webauthn) {
    throw new Error('Passkeys are not supported by this app version.');
  }
  const { data, error } = await supabase.auth.mfa.webauthn.register({
    friendlyName: friendlyName || `Passkey ${new Date().toLocaleDateString()}`,
  });
  if (error) throw error;
  return data;
}

// Authenticate an existing passkey factor — used to clear the sign-in MFA
// challenge with a passkey instead of a TOTP code.
export async function authenticatePasskey(factorId) {
  if (!supabase.auth.mfa.webauthn) {
    throw new Error('Passkeys are not supported by this app version.');
  }
  const { data, error } = await supabase.auth.mfa.webauthn.authenticate({ factorId });
  if (error) throw error;
  return data;
}

// --- Trusted device ledger (V2 backend) ------------------------------------

// Ask the backend whether this browser's stored trust token still skips MFA.
// Returns true only for a live, signature-valid, non-expired token.
export async function isDeviceTrusted() {
  const token = getTrustToken();
  if (!token) return false;
  try {
    const res = await api.post('/auth/mfa/verify-device', { token });
    if (!res.trusted) clearTrustToken(); // stale — drop it
    return !!res.trusted;
  } catch {
    return false; // network / config error — fail closed (challenge the user)
  }
}

// After clearing the MFA challenge with "trust this device" ticked, mint and
// store a 30-day trust token. Best-effort: a failure here just means the user
// will be challenged again next time.
export async function trustThisDevice() {
  const res = await api.post('/auth/mfa/trust', {});
  if (res.token) setTrustToken(res.token);
  return res;
}

// Trusted device management (Settings).
export async function listTrustedDevices() {
  const res = await api.get('/auth/mfa/devices');
  return res.devices || [];
}

export async function revokeTrustedDevice(id) {
  await api.delete(`/auth/mfa/devices/${id}`);
}
