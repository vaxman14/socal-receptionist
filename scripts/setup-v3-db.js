#!/usr/bin/env node
// scripts/setup-v3-db.js — Apply all V3 DB migrations to a fresh Supabase project.
//
// Usage:
//   V3_DB_URL="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres" \
//   node scripts/setup-v3-db.js
//
// If V3_DB_URL is not set, the script generates v2/db/v3-migrations-combined.sql
// which you can paste directly into the Supabase SQL editor.

const fs = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', 'v2', '.env.v3') });

const MIGRATION_DIR = path.join(__dirname, '..', 'v2', 'db');
const COMBINED_OUT = path.join(MIGRATION_DIR, 'v3-migrations-combined.sql');

const MIGRATIONS = [
  '001_init.sql',
  '002_agreements.sql',
  '003_documents.sql',
  '004_voice.sql',
  '005_billing_refund.sql',
  '006_mfa.sql',
  '007_time_tickets.sql',
  '007_voice_id.sql', // numbering collision with time_tickets — both are real, order matters not
  '009_outbound_leads_integrations.sql',
  '010_rls_complete.sql',
  '011_outbound_assist.sql',
  '012_public_api.sql',
];

function buildCombined() {
  const parts = MIGRATIONS.map((f) => {
    const fp = path.join(MIGRATION_DIR, f);
    if (!fs.existsSync(fp)) {
      console.warn(`  ⚠️  ${f} not found — skipping`);
      return '';
    }
    return `-- ============================================================\n-- Migration: ${f}\n-- ============================================================\n\n${fs.readFileSync(fp, 'utf8')}\n\n`;
  });
  return parts.filter(Boolean).join('\n');
}

async function main() {
  const dbUrl = process.env.V3_DB_URL;

  if (!dbUrl) {
    // No connection string — write combined SQL for manual paste
    console.log('\nℹ️  V3_DB_URL not set — generating combined SQL file instead.\n');
    const sql = buildCombined();
    fs.writeFileSync(COMBINED_OUT, sql);
    console.log(`📄 Written: v2/db/v3-migrations-combined.sql (${Math.round(sql.length / 1024)} KB)\n`);
    console.log('To apply:\n');
    console.log('  Option A — paste in Supabase SQL editor:');
    console.log('    1. Open your V3 Supabase project → SQL Editor');
    console.log('    2. Paste the contents of v2/db/v3-migrations-combined.sql');
    console.log('    3. Click Run\n');
    console.log('  Option B — psql (if you have postgres tools installed):');
    console.log('    V3_DB_URL="postgresql://postgres:[PASSWORD]@db.[REF].supabase.co:5432/postgres" \\');
    console.log('    node scripts/setup-v3-db.js\n');
    return;
  }

  // Check psql is available
  const psqlCheck = spawnSync('which', ['psql'], { encoding: 'utf8' });
  if (psqlCheck.status !== 0) {
    console.log('\npsql not found — installing via homebrew…\n');
    try {
      execSync('brew install libpq && brew link --force libpq', { stdio: 'inherit' });
    } catch {
      console.error('Could not install psql. Use Option A above (paste SQL in dashboard).');
      const sql = buildCombined();
      fs.writeFileSync(COMBINED_OUT, sql);
      console.log(`\nCombined SQL written to: v2/db/v3-migrations-combined.sql`);
      process.exit(1);
    }
  }

  console.log(`\n🚀 Applying V3 migrations to: ${dbUrl.replace(/:[^:@]+@/, ':***@')}\n`);

  for (const filename of MIGRATIONS) {
    const filepath = path.join(MIGRATION_DIR, filename);
    if (!fs.existsSync(filepath)) {
      console.warn(`  ⚠️  ${filename} — not found, skipping`);
      continue;
    }

    process.stdout.write(`  ▶ ${filename}… `);
    const result = spawnSync('psql', [dbUrl, '-f', filepath, '-v', 'ON_ERROR_STOP=1'], {
      encoding: 'utf8',
      timeout: 30000,
    });

    if (result.status !== 0) {
      console.log('❌');
      console.error('\nError output:');
      console.error((result.stderr || result.stdout || '').slice(0, 800));
      process.exit(1);
    }
    console.log('✅');
  }

  console.log('\n✅ All migrations applied!\n');
  console.log('Copy v2/.env.v3 to v2/.env and start the server:\n');
  console.log('  cd v2 && cp .env.v3 .env && npm start\n');
}

main().catch((err) => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
