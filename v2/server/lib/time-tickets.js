// Time ticket helpers — AI enrichment via Groq + CRUD against Supabase.

const Groq = require('groq-sdk');
const { supabase } = require('./supabase');

let _groq;
function groqClient() {
  if (!_groq) _groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
  return _groq;
}

// Round seconds up to the nearest billing increment (default 6 min = 0.1h).
function billableMins(durationSec, incrementMins = 6) {
  if (!durationSec) return incrementMins;
  const raw = Math.ceil(durationSec / 60);
  return Math.ceil(raw / incrementMins) * incrementMins;
}

// Use Groq to extract structured ticket fields from a call transcript.
// Returns { matter_name, client_name, description, activity, ai_confidence }.
async function enrichFromTranscript(transcript, businessName) {
  if (!process.env.GROQ_API_KEY || !transcript) {
    return { description: transcript ? transcript.slice(0, 200) : '', ai_confidence: 0 };
  }

  const prompt = `You are a legal billing assistant. Extract structured time-entry data from this call transcript.

Business: ${businessName}
Transcript:
${transcript.slice(0, 3000)}

Respond with valid JSON only — no markdown, no explanation:
{
  "client_name": "<caller's name if mentioned, else null>",
  "matter_name": "<inferred matter/topic in 3-5 words, e.g. 'Auto accident consultation'>",
  "activity": "<one of: phone_call | consultation | follow_up | voicemail_review | correspondence | other>",
  "description": "<1-2 sentence billing description suitable for an invoice, professional tone>",
  "confidence": <0-100 integer>
}`;

  try {
    const response = await groqClient().chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 300,
    });

    const text = response.choices[0].message.content.trim();
    const parsed = JSON.parse(text);
    return {
      client_name: parsed.client_name || null,
      matter_name: parsed.matter_name || null,
      activity: parsed.activity || 'phone_call',
      description: parsed.description || '',
      ai_confidence: Number(parsed.confidence) || 50,
    };
  } catch (err) {
    console.error('[time-tickets] AI enrichment failed:', err.message);
    return { description: transcript.slice(0, 200), ai_confidence: 0 };
  }
}

// Draft a time ticket from a completed call record.
// call: { id, tenant_id, transcript, duration_seconds, outcome, from_number, conversation_id }
// tenant: { id, business_name, default_hourly_rate, billing_increment_mins }
async function draftFromCall(call, tenant) {
  const source = call.outcome === 'voicemail' ? 'call_voicemail' : 'call_inbound';
  const transcript = call.transcript || '';
  const enriched = await enrichFromTranscript(transcript, tenant.business_name);
  const increment = tenant.billing_increment_mins || 6;

  const ticket = {
    tenant_id: tenant.id,
    call_id: call.id,
    conversation_id: call.conversation_id || null,
    source,
    status: 'draft',
    activity: enriched.activity || 'phone_call',
    matter_name: enriched.matter_name || null,
    client_name: enriched.client_name || null,
    description: enriched.description || '',
    duration_sec: call.duration_seconds || null,
    billable_mins: billableMins(call.duration_seconds, increment),
    hourly_rate: tenant.default_hourly_rate || null,
    ai_summary: transcript.slice(0, 500) || null,
    ai_confidence: enriched.ai_confidence,
  };

  const { data, error } = await supabase
    .from('time_tickets')
    .insert(ticket)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// List tickets for a tenant with optional status filter.
async function listTickets(tenantId, { status, limit = 100 } = {}) {
  let q = supabase
    .from('time_tickets')
    .select('*, call:calls(from_number, to_number, outcome)')
    .eq('tenant_id', tenantId)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (status) q = q.eq('status', status);

  const { data, error } = await q;
  if (error) throw error;
  return data;
}

// Accept or edit a ticket.
async function updateTicket(id, tenantId, patch) {
  const allowed = [
    'status', 'activity', 'matter_name', 'client_name', 'description',
    'duration_sec', 'billable_mins', 'hourly_rate', 'matter_id', 'billed_at',
  ];
  const safe = {};
  for (const k of allowed) {
    if (patch[k] !== undefined) safe[k] = patch[k];
  }

  if (safe.status === 'accepted') {
    safe.reviewed_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('time_tickets')
    .update(safe)
    .eq('id', id)
    .eq('tenant_id', tenantId)
    .select()
    .single();

  if (error) throw error;
  return data;
}

// Bulk-accept all draft tickets for a tenant.
async function bulkAccept(tenantId) {
  const { data, error } = await supabase
    .from('time_tickets')
    .update({ status: 'accepted', reviewed_at: new Date().toISOString() })
    .eq('tenant_id', tenantId)
    .eq('status', 'draft')
    .select('id');

  if (error) throw error;
  return data?.length || 0;
}

// Export accepted tickets as CSV rows.
async function exportCsv(tenantId) {
  const { data, error } = await supabase
    .from('time_tickets')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'accepted')
    .order('created_at', { ascending: true });

  if (error) throw error;

  // Escape a CSV cell: quote it, double any interior quotes, and prefix
  // formula-leading characters (=, +, -, @, tab, CR) with a tab so spreadsheet
  // apps don't execute them as formulas (CSV injection, issue #8).
  function csvCell(value) {
    const s = String(value ?? '');
    const safe = /^[=+\-@\t\r]/.test(s) ? `\t${s}` : s;
    return `"${safe.replace(/"/g, '""')}"`;
  }

  const headers = ['date', 'client', 'matter', 'activity', 'description', 'duration_min', 'billable_min', 'rate', 'amount'];
  const rows = (data || []).map((t) => {
    const date = new Date(t.created_at).toISOString().slice(0, 10);
    const mins = t.billable_mins || 0;
    const rate = t.hourly_rate || '';
    const amount = rate ? ((mins / 60) * rate).toFixed(2) : '';
    return [
      csvCell(date),
      csvCell(t.client_name || ''),
      csvCell(t.matter_name || ''),
      csvCell(t.activity || ''),
      csvCell(t.description || ''),
      csvCell(t.duration_sec ? Math.round(t.duration_sec / 60) : ''),
      csvCell(mins),
      csvCell(rate),
      csvCell(amount),
    ].join(',');
  });

  return [headers.join(','), ...rows].join('\n');
}

module.exports = { draftFromCall, listTickets, updateTicket, bulkAccept, exportCsv };
