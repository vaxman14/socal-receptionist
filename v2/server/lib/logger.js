// Structured logging.
//
// One JSON line per event, carrying tenant context where available, so logs
// can be filtered/aggregated per tenant (Codex hardening: observability).

function emit(level, event, fields) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event, ...(fields || {}) });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

module.exports = {
  info: (event, fields) => emit('info', event, fields),
  warn: (event, fields) => emit('warn', event, fields),
  error: (event, fields) => emit('error', event, fields),
};
