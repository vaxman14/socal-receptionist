// Editable documents — DB access layer (migration 003).
//
// Two document kinds, both managed from the owner admin:
//   * legal_documents   — policy / info pages, edited in place.
//   * contract_versions — e-sign Service Agreement; new versions are uploaded
//                         and then published to become the one clients sign.

const crypto = require('crypto');
const { supabase } = require('./supabase');
const seed = require('../contracts');

// Slugs the admin may edit. Keeps a typo from creating a junk document.
const LEGAL_DOC_SLUGS = ['privacy', 'terms', 'cookies', 'accessibility', 'faq', 'support'];

class DocumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DocumentError';
  }
}

function hashBody(body) {
  return crypto.createHash('sha256').update(body, 'utf8').digest('hex');
}

// --- Legal documents --------------------------------------------------------

async function listDocuments() {
  const { data, error } = await supabase
    .from('legal_documents')
    .select('*')
    .order('slug', { ascending: true });
  if (error) throw error;
  return data || [];
}

async function getDocument(slug) {
  const { data, error } = await supabase
    .from('legal_documents')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

// Create or update a policy/info page. Restricted to known slugs.
async function upsertDocument(slug, { title, body }, userId = null) {
  if (!LEGAL_DOC_SLUGS.includes(slug)) {
    throw new DocumentError(`unknown document slug: ${slug}`);
  }
  if (!title || !String(title).trim()) throw new DocumentError('title required');
  if (!body || !String(body).trim()) throw new DocumentError('body required');

  const row = {
    slug,
    title: String(title).trim(),
    body: String(body),
    updated_by: userId,
  };
  const { data, error } = await supabase
    .from('legal_documents')
    .upsert(row, { onConflict: 'slug' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// --- Contract versions ------------------------------------------------------

// The current contract clients sign. Auto-seeds v1 from the shipped file the
// first time it is called against an empty table, so the e-sign flow works
// even before scripts/seed-documents.js is run.
async function getCurrentContract() {
  const { data, error } = await supabase
    .from('contract_versions')
    .select('*')
    .eq('is_current', true)
    .maybeSingle();
  if (error) throw error;
  if (data) return data;
  return seedInitialContract();
}

async function seedInitialContract() {
  const body = seed.getSeedContractBody();
  const { data, error } = await supabase
    .from('contract_versions')
    .insert({
      version: seed.SEED_CONTRACT_VERSION,
      title: seed.SEED_CONTRACT_TITLE,
      body,
      content_hash: hashBody(body),
      is_current: true,
      published_at: new Date().toISOString(),
    })
    .select()
    .single();
  if (error) {
    // Lost a race with another process that seeded first — re-read.
    const { data: existing } = await supabase
      .from('contract_versions')
      .select('*')
      .eq('is_current', true)
      .maybeSingle();
    if (existing) return existing;
    throw error;
  }
  return data;
}

async function getContractByVersion(version) {
  const { data, error } = await supabase
    .from('contract_versions')
    .select('*')
    .eq('version', version)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

async function listContractVersions() {
  const { data, error } = await supabase
    .from('contract_versions')
    .select('id, version, title, content_hash, is_current, published_at, created_at, created_by')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data || [];
}

// Upload a new contract version. It is created NOT current — publish it
// separately so an upload never silently changes what clients sign.
async function createContractVersion({ version, title, body }, userId = null) {
  const v = (version || '').trim();
  if (!v) throw new DocumentError('version required (e.g. "v2")');
  if (!title || !String(title).trim()) throw new DocumentError('title required');
  if (!body || !String(body).trim()) throw new DocumentError('body required');

  if (await getContractByVersion(v)) {
    throw new DocumentError(`contract version "${v}" already exists`);
  }

  const { data, error } = await supabase
    .from('contract_versions')
    .insert({
      version: v,
      title: String(title).trim(),
      body: String(body),
      content_hash: hashBody(String(body)),
      is_current: false,
      created_by: userId,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Make a version the current contract. Unsets the previous current first so the
// single-current unique index is never violated.
async function publishContractVersion(id, userId = null) {
  const { data: target, error: findErr } = await supabase
    .from('contract_versions')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (findErr) throw findErr;
  if (!target) throw new DocumentError('contract version not found');
  if (target.is_current) return target; // already current — idempotent

  // Atomic swap via DB function — clears old current and sets new one in a
  // single transaction so there is never a window with zero current contracts.
  const { data, error } = await supabase
    .rpc('publish_contract_version', { p_id: id })
    .select()
    .single();
  if (error) throw error;

  await supabase.from('audit_log').insert({
    tenant_id: null,
    actor_type: 'owner',
    actor_user_id: userId,
    action: 'contract_version.published',
    target_type: 'contract_version',
    target_id: id,
    metadata: { version: data.version, content_hash: data.content_hash },
  });

  return data;
}

module.exports = {
  DocumentError,
  LEGAL_DOC_SLUGS,
  hashBody,
  listDocuments,
  getDocument,
  upsertDocument,
  getCurrentContract,
  getContractByVersion,
  listContractVersions,
  createContractVersion,
  publishContractVersion,
};
