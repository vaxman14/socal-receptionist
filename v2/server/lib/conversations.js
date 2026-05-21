// Conversation persistence.
//
// Replaces V1's in-memory store.js: conversation state lives in Postgres so it
// survives restarts and is shared across instances. One open conversation per
// (tenant, customer) — enforced by a partial unique index in db/001_init.sql.

const { supabase } = require('./supabase');

const HISTORY_LIMIT = 40; // transcript turns loaded as AI context

// Return the customer's open conversation, creating one if none exists.
async function getOrCreateConversation(tenantId, customerPhone) {
  const { data: existing, error } = await supabase
    .from('conversations')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('customer_phone', customerPhone)
    .eq('status', 'open')
    .maybeSingle();
  if (error) throw error;
  if (existing) return existing;

  const { data: created, error: insErr } = await supabase
    .from('conversations')
    .insert({ tenant_id: tenantId, customer_phone: customerPhone })
    .select()
    .single();
  if (insErr) throw insErr;
  return created;
}

// Load the recent transcript as OpenAI chat messages, oldest first.
async function loadTranscript(conversationId) {
  const { data, error } = await supabase
    .from('messages')
    .select('role, body, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) throw error;
  return (data || [])
    .reverse()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: m.body }));
}

// Append one transcript turn and bump the conversation's last_message_at.
async function appendMessage(conversation, opts) {
  const { direction, role, body, twilioSid = null, tokens = null, costCents = null } = opts;
  const { error } = await supabase.from('messages').insert({
    conversation_id: conversation.id,
    tenant_id: conversation.tenant_id,
    direction,
    role,
    body,
    twilio_sid: twilioSid,
    openai_tokens: tokens,
    cost_cents: costCents,
  });
  if (error) throw error;

  await supabase
    .from('conversations')
    .update({ last_message_at: new Date().toISOString() })
    .eq('id', conversation.id);
}

module.exports = { getOrCreateConversation, loadTranscript, appendMessage, HISTORY_LIMIT };
