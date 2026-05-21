// Tenant lifecycle state machine.
//
// Codex review #2: provisioning must be an explicit state machine, not an
// inline Stripe-webhook side effect. Every tenant status change goes through
// transitionTenant(), which validates the move and writes an audit_log entry.
// No other code should UPDATE tenants.status directly.

const { supabase } = require('./supabase');

// Allowed transitions: current status -> set of permitted next statuses.
// Statuses are defined by the `tenant_status` enum in db/001_init.sql.
const TRANSITIONS = {
  onboarding:            ['sms_pending_compliance', 'active', 'failed_provisioning'],
  sms_pending_compliance:['active', 'suspended_compliance', 'failed_provisioning'],
  active:                ['suspended_billing', 'suspended_compliance'],
  suspended_billing:     ['active', 'failed_provisioning'],
  suspended_compliance:  ['active', 'failed_provisioning'],
  failed_provisioning:   ['onboarding'], // manual retry by a platform admin
};

function canTransition(from, to) {
  return Boolean(TRANSITIONS[from] && TRANSITIONS[from].includes(to));
}

class InvalidTransitionError extends Error {
  constructor(from, to) {
    super(`Invalid tenant transition: ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
    this.from = from;
    this.to = to;
  }
}

// Move a tenant to `toStatus`. Validates the transition, applies it with an
// optimistic lock on the previous status, and records an audit_log entry.
// Returns the updated tenant row. A no-op (already in toStatus) is allowed and
// returns silently — callers can be idempotent.
async function transitionTenant(tenantId, toStatus, opts = {}) {
  const {
    actorType = 'system',
    actorUserId = null,
    reason = null,
    metadata = {},
  } = opts;

  const { data: tenant, error } = await supabase
    .from('tenants')
    .select('id, status')
    .eq('id', tenantId)
    .single();
  if (error) throw error;

  const from = tenant.status;
  if (from === toStatus) return tenant; // idempotent no-op
  if (!canTransition(from, toStatus)) throw new InvalidTransitionError(from, toStatus);

  const patch = { status: toStatus };
  if (toStatus === 'active') patch.activated_at = new Date().toISOString();

  const { data: updated, error: upErr } = await supabase
    .from('tenants')
    .update(patch)
    .eq('id', tenantId)
    .eq('status', from) // optimistic lock — fails if another writer moved it
    .select('id, status')
    .single();
  if (upErr) throw upErr;

  await supabase.from('audit_log').insert({
    tenant_id: tenantId,
    actor_type: actorType,
    actor_user_id: actorUserId,
    action: 'tenant.status_changed',
    target_type: 'tenant',
    target_id: tenantId,
    metadata: { from, to: toStatus, reason, ...metadata },
  });

  return updated;
}

module.exports = { TRANSITIONS, canTransition, transitionTenant, InvalidTransitionError };
