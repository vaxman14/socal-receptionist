// Tracks SMS opt-in consent per phone number (in-memory, V1).
// States: 'unknown' | 'pending' | 'opted_in' | 'opted_out'
// Twilio automatically blocks outbound messages to numbers that texted STOP,
// but we track it here too so we never feed opted-out numbers to the AI.

const statuses = new Map();

function getStatus(phone) {
  return statuses.get(phone) || 'unknown';
}

function setStatus(phone, status) {
  statuses.set(phone, status);
}

module.exports = { getStatus, setStatus };
