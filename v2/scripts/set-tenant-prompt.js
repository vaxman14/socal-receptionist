#!/usr/bin/env node
// View or set the ai_system_prompt for a tenant by phone number.
//
// Usage:
//   node v2/scripts/set-tenant-prompt.js +19513958776          # view current prompt
//   node v2/scripts/set-tenant-prompt.js +19513958776 prompt.txt  # set from file
//   node v2/scripts/set-tenant-prompt.js +19513958776 --clear  # clear (use platform default)

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

async function main() {
  const [,, phone, arg] = process.argv;
  if (!phone) {
    console.error('Usage: node set-tenant-prompt.js <phone_e164> [prompt.txt | --clear]');
    process.exit(1);
  }

  const { data: row, error: lookupErr } = await supabase
    .from('phone_numbers')
    .select('tenant_id, tenants(id, business_name, ai_system_prompt)')
    .eq('phone_e164', phone)
    .maybeSingle();

  if (lookupErr) { console.error('Lookup failed:', lookupErr.message); process.exit(1); }
  if (!row) { console.error(`No tenant found for ${phone}`); process.exit(1); }

  const tenant = row.tenants;

  if (!arg) {
    console.log(`Tenant: ${tenant.business_name} (${tenant.id})`);
    console.log(`Phone:  ${phone}`);
    console.log('');
    if (tenant.ai_system_prompt) {
      console.log('--- Current ai_system_prompt ---');
      console.log(tenant.ai_system_prompt);
    } else {
      console.log('ai_system_prompt: (none — using platform default)');
    }
    return;
  }

  let newPrompt = null;
  if (arg === '--clear') {
    newPrompt = null;
  } else {
    if (!fs.existsSync(arg)) { console.error(`File not found: ${arg}`); process.exit(1); }
    newPrompt = fs.readFileSync(arg, 'utf8').trim();
  }

  const { error: updateErr } = await supabase
    .from('tenants')
    .update({ ai_system_prompt: newPrompt })
    .eq('id', tenant.id);

  if (updateErr) { console.error('Update failed:', updateErr.message); process.exit(1); }
  console.log(`Done. Prompt ${newPrompt ? 'updated' : 'cleared'} for ${tenant.business_name}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
