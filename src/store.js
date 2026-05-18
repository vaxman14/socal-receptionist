// In-memory conversation store. No database in V1.
//
// Each conversation is keyed by the customer's phone number so the AI can
// qualify a lead across multiple texts. State lives only in this process:
// it is cleared on restart and is NOT shared across multiple instances.
// See the README "Scaling notes" section for the V2 upgrade path.

const TTL_MS = 30 * 60 * 1000; // forget a conversation after 30 min idle
const MAX_MESSAGES = 40; // cap history length per conversation

const conversations = new Map();

function get(phone) {
  const entry = conversations.get(phone);
  if (entry && Date.now() - entry.updatedAt < TTL_MS) {
    return entry.messages;
  }
  conversations.delete(phone);
  return [];
}

function set(phone, messages) {
  // Keep history bounded, and never start on an orphan tool/assistant
  // message — OpenAI requires the trimmed history to begin cleanly.
  let trimmed = messages.slice(-MAX_MESSAGES);
  while (trimmed.length && trimmed[0].role !== 'user') {
    trimmed.shift();
  }
  conversations.set(phone, { messages: trimmed, updatedAt: Date.now() });
}

// Periodically evict stale conversations so memory stays flat.
setInterval(() => {
  const now = Date.now();
  for (const [phone, entry] of conversations) {
    if (now - entry.updatedAt > TTL_MS) conversations.delete(phone);
  }
}, 10 * 60 * 1000).unref();

module.exports = { get, set };
