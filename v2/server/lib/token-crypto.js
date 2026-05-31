// Shared encrypt/decrypt helpers for OAuth tokens stored in tenant_integrations.
// TOKEN_ENCRYPTION_KEY must be a 32-byte (64 hex chars) AES-256 key.
// If not set, tokens are stored plaintext (development only).

const crypto = require('crypto');

const KEY_HEX = process.env.TOKEN_ENCRYPTION_KEY || '';

// Warn at boot if TOKEN_ENCRYPTION_KEY is missing and practice management
// integrations are potentially in use (non-development environment).
if (!KEY_HEX && process.env.NODE_ENV !== 'development') {
  console.warn(
    '[token-crypto] TOKEN_ENCRYPTION_KEY is not set — OAuth tokens will be stored ' +
    'in plaintext. Set a 64-hex-char AES-256 key in production.'
  );
}

function encryptToken(plaintext) {
  if (!KEY_HEX || !plaintext) return plaintext;
  const key = Buffer.from(KEY_HEX, 'hex');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `enc:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decryptToken(value) {
  if (!KEY_HEX || !value || !value.startsWith('enc:')) return value;
  const parts = value.split(':');
  // format: enc:<ivHex>:<tagHex>:<encHex>
  if (parts.length !== 4) return value;
  const [, ivHex, tagHex, encHex] = parts;
  const key = Buffer.from(KEY_HEX, 'hex');
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString('utf8') + decipher.final('utf8');
}

module.exports = { encryptToken, decryptToken };
