'use strict';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const form         = document.getElementById('logForm');
const clientInput  = document.getElementById('clientMatter');
const descInput    = document.getElementById('description');
const durationInput = document.getElementById('durationMins');
const submitBtn    = document.getElementById('submitBtn');
const statusMsg    = document.getElementById('statusMsg');
const activityList = document.getElementById('activityList');
const ticketList   = document.getElementById('ticketList');
const closeBtn     = document.getElementById('closeBtn');

// ── Close / hide ──────────────────────────────────────────────────────────────
closeBtn.addEventListener('click', () => window.close());

// ── Recent activity feed ──────────────────────────────────────────────────────
const MAX_ACTIVITY = 5;
const activities = [];

function fmtTime(isoStr) {
  try {
    return new Date(isoStr).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function renderActivity() {
  if (activities.length === 0) {
    activityList.innerHTML = '<div class="empty-state">No activity captured yet</div>';
    return;
  }
  activityList.innerHTML = activities
    .slice()
    .reverse()
    .map((a) => `
      <div class="activity-item" data-title="${escHtml(a.title)}" data-app="${escHtml(a.app)}">
        <div class="app-name">${escHtml(a.app)}</div>
        <div class="win-title">${escHtml(a.title || '—')}</div>
        <div class="activity-time">${fmtTime(a.ts)}</div>
      </div>
    `)
    .join('');

  // Click to use as description
  activityList.querySelectorAll('.activity-item').forEach((el) => {
    el.addEventListener('click', () => {
      const appName = el.dataset.app;
      const title   = el.dataset.title;
      descInput.value = title ? `${appName} — ${title}` : appName;
      descInput.focus();
    });
  });
}

// Load historical activity on page ready
window.addEventListener('DOMContentLoaded', async () => {
  if (window.desktopAPI?.getRecentActivity) {
    const recent = await window.desktopAPI.getRecentActivity(MAX_ACTIVITY);
    if (Array.isArray(recent)) {
      activities.push(...recent);
      renderActivity();
    }
  }
});

// Stream live activity events from main process
if (window.desktopAPI?.onActivityLog) {
  window.desktopAPI.onActivityLog((entry) => {
    activities.push(entry);
    if (activities.length > MAX_ACTIVITY) activities.shift();
    renderActivity();
  });
}

// ── Live ticket list ──────────────────────────────────────────────────────────
const MAX_TICKETS = 5;
const tickets = [];

function renderTickets() {
  if (tickets.length === 0) {
    ticketList.innerHTML = '<div class="empty-state">No tickets yet this session</div>';
    return;
  }
  ticketList.innerHTML = tickets
    .slice()
    .reverse()
    .map((t) => {
      const rec = t.new || t;
      return `
        <div class="ticket-item">
          <div class="ticket-matter">${escHtml(rec.client_matter || '—')}</div>
          <div class="ticket-desc">${escHtml(rec.description || '')}</div>
          <div class="ticket-meta">${rec.duration_minutes ?? '?'} min · ${fmtTime(rec.logged_at || rec.created_at)}</div>
        </div>
      `;
    })
    .join('');
}

if (window.desktopAPI?.onTicketUpdate) {
  window.desktopAPI.onTicketUpdate((payload) => {
    if (payload.eventType === 'DELETE') return;
    tickets.push(payload);
    if (tickets.length > MAX_TICKETS) tickets.shift();
    renderTickets();
  });
}

// ── Form submit ───────────────────────────────────────────────────────────────
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  setStatus('');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Logging…';

  const data = {
    clientMatter: clientInput.value.trim(),
    description:  descInput.value.trim(),
    durationMins: parseInt(durationInput.value, 10) || 0,
  };

  try {
    const result = await window.desktopAPI.submitQuickLog(data);
    if (result?.error) {
      setStatus(result.error, 'error');
    } else {
      setStatus('Time logged!', 'ok');
      form.reset();
      clientInput.focus();
      // Add optimistic ticket entry to local list
      tickets.push({
        new: {
          client_matter: data.clientMatter,
          description: data.description,
          duration_minutes: data.durationMins,
          logged_at: new Date().toISOString(),
        },
      });
      if (tickets.length > MAX_TICKETS) tickets.shift();
      renderTickets();
    }
  } catch (err) {
    setStatus(err.message || 'Unknown error', 'error');
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Log Time';
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function setStatus(msg, type = '') {
  statusMsg.textContent = msg;
  statusMsg.className = `status ${type}`;
  if (msg && type === 'ok') {
    setTimeout(() => { statusMsg.textContent = ''; statusMsg.className = 'status'; }, 3000);
  }
}

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Auto-focus client input on show ───────────────────────────────────────────
clientInput.focus();
