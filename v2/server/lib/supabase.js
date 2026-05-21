// Service-role Supabase client for the V2 backend (SMS pipeline + provisioning).
//
// The service role key bypasses Row Level Security — this module is for backend
// code ONLY and must never reach the browser. The client/owner admin apps use a
// separate anon/auth client constrained by the RLS policies in db/001_init.sql.

const { createClient } = require('@supabase/supabase-js');

const url = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_KEY;

if (!url || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_KEY environment variables are required');
}

const supabase = createClient(url, serviceKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

module.exports = { supabase };
