// Appointment availability engine for the AI receptionist.
//
// Generates bookable slots from a tenant's standing window + the four guardrails
// (slot length, buffer, min lead time, daily cap), then subtracts Google
// Calendar freebusy so any existing event — including ones the owner drops to
// block time — makes that slot unavailable. Pure logic; the caller supplies the
// busy intervals (from google-calendar.getFreeBusy) so this stays testable.

// Minutes that `tz` is ahead of UTC at the given instant (negative for PT).
function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = dtf.formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  const asUTC = Date.UTC(p.year, p.month - 1, p.day, p.hour === '24' ? 0 : p.hour, p.minute, p.second);
  return (asUTC - date.getTime()) / 60000;
}

// Build a Date for a given local wall-clock time in `tz`.
function zonedTime(y, mo, d, hh, mm, tz) {
  let utc = Date.UTC(y, mo, d, hh, mm, 0);
  const off = tzOffsetMinutes(new Date(utc), tz);
  return new Date(utc - off * 60000);
}

// Local Y/M/D for a Date in `tz`.
function localYMD(date, tz) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date).reduce((a, x) => (a[x.type] = x.value, a), {});
  return { y: +p.year, mo: +p.month - 1, d: +p.day };
}

function cfg(tenant) {
  return {
    enabled:    !!tenant.booking_enabled,
    days:       String(tenant.bookable_days || '1,2,3,4,5').split(',').map(s => +s.trim()).filter(n => !Number.isNaN(n)),
    startMin:   tenant.bookable_start_min ?? 540,
    endMin:     tenant.bookable_end_min ?? 1020,
    slot:       tenant.slot_length_mins ?? 30,
    buffer:     tenant.booking_buffer_mins ?? 0,
    minLead:    tenant.booking_min_lead_mins ?? 120,
    maxPerDay:  tenant.max_bookings_per_day ?? 8,
    tz:         tenant.timezone || 'America/Los_Angeles',
  };
}

function overlapsBusy(start, end, busy) {
  return busy.some(b => start < b.end && end > b.start);
}

// Returns up to `count` slots: [{ start: ISO, label }]. lookaheadDays bounds the search.
function computeSlots(tenant, busy, { count = 3, lookaheadDays = 14, now = new Date() } = {}) {
  const c = cfg(tenant);
  if (!c.enabled) return [];
  const earliest = new Date(now.getTime() + c.minLead * 60000);
  const step = c.slot + c.buffer;
  const slots = [];

  for (let dayOffset = 0; dayOffset <= lookaheadDays && slots.length < count; dayOffset++) {
    const probe = new Date(now.getTime() + dayOffset * 86400000);
    const { y, mo, d } = localYMD(probe, c.tz);
    // Determine weekday in tz via a noon anchor.
    const weekday = new Intl.DateTimeFormat('en-US', { timeZone: c.tz, weekday: 'short' })
      .format(zonedTime(y, mo, d, 12, 0, c.tz));
    const dowNum = { Sun:0, Mon:1, Tue:2, Wed:3, Thu:4, Fri:5, Sat:6 }[weekday];
    if (!c.days.includes(dowNum)) continue;

    let bookedToday = 0;
    for (let m = c.startMin; m + c.slot <= c.endMin && slots.length < count; m += step) {
      const start = zonedTime(y, mo, d, Math.floor(m / 60), m % 60, c.tz);
      const end   = new Date(start.getTime() + c.slot * 60000);
      if (start < earliest) continue;
      // Apply buffer around busy by padding the candidate window.
      const padStart = new Date(start.getTime() - c.buffer * 60000);
      const padEnd   = new Date(end.getTime()   + c.buffer * 60000);
      if (overlapsBusy(padStart, padEnd, busy)) { bookedToday++; continue; }
      if (bookedToday >= c.maxPerDay) break;
      slots.push({ start: start.toISOString(), label: labelSlot(start, c.tz) });
    }
  }
  return slots;
}

function labelSlot(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZone: tz,
  }).format(date);
}

module.exports = { computeSlots, cfg };
