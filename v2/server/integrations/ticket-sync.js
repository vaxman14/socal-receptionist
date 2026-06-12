// Background time-entry sync — pushes accepted, unbilled time tickets to the
// tenant's connected practice management system (Clio or MyCase).
//
// The manual route (POST /integrations/:provider/push-ticket/:ticketId) stays
// available; this worker automates the same push for every accepted ticket.
// A pushed ticket gets billed_at set, which is what keeps it from pushing twice.

const { supabase } = require('../lib/supabase');
const logger = require('../lib/logger');
const clio = require('./clio');
const mycase = require('./mycase');

const SYNC_INTERVAL_MS = Number(process.env.TICKET_SYNC_INTERVAL_MS) || 10 * 60 * 1000;
const BATCH_PER_TENANT = 25;

const PUSHERS = { clio: clio.pushTimeEntry, mycase: mycase.pushTimeEntry };

async function syncOnce() {
  const { data: integrations, error } = await supabase
    .from('tenant_integrations')
    .select('tenant_id, provider')
    .in('provider', ['clio', 'mycase'])
    .eq('enabled', true)
    .not('access_token', 'is', null);
  if (error) {
    logger.error('ticket-sync.list_integrations_failed', { error: error.message });
    return;
  }

  // One destination per tenant — if both Clio and MyCase are connected, the
  // first row wins. Pushing the same ticket to two systems double-bills.
  const byTenant = new Map();
  for (const integ of integrations || []) {
    if (!byTenant.has(integ.tenant_id)) byTenant.set(integ.tenant_id, integ.provider);
  }

  for (const [tenantId, provider] of byTenant) {
    try {
      await syncTenant(tenantId, provider);
    } catch (err) {
      logger.error('ticket-sync.tenant_failed', { tenant_id: tenantId, provider, error: err.message });
    }
  }
}

async function syncTenant(tenantId, provider) {
  const { data: tickets, error } = await supabase
    .from('time_tickets')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('status', 'accepted')
    .is('billed_at', null)
    .order('created_at', { ascending: true })
    .limit(BATCH_PER_TENANT);
  if (error) throw error;
  if (!tickets || !tickets.length) return;

  let pushed = 0;
  for (const ticket of tickets) {
    try {
      await PUSHERS[provider](tenantId, ticket);
      await supabase
        .from('time_tickets')
        .update({ billed_at: new Date().toISOString() })
        .eq('id', ticket.id);
      pushed++;
    } catch (err) {
      // pushTimeEntry records last_error on the integration row; a token or
      // API problem likely affects the whole tenant, so stop this round.
      logger.error('ticket-sync.push_failed', { tenant_id: tenantId, provider, ticket_id: ticket.id, error: err.message });
      break;
    }
  }
  if (pushed) logger.info('ticket-sync.pushed', { tenant_id: tenantId, provider, count: pushed });
}

let timer = null;
function start() {
  if (timer) return;
  timer = setInterval(() => {
    syncOnce().catch((err) => logger.error('ticket-sync.run_failed', { error: err.message }));
  }, SYNC_INTERVAL_MS);
  if (timer.unref) timer.unref();
  logger.info('ticket-sync.started', { interval_ms: SYNC_INTERVAL_MS });
}

module.exports = { start, syncOnce };
