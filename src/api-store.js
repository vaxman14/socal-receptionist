// Persistent store for public API data: leads, calls, api keys, webhooks.
// Uses flat JSON files so V3 stays dependency-free.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadFile(name) {
  const p = path.join(DATA_DIR, name);
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return []; }
}

function saveFile(name, data) {
  fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
}

// --- Leads ---
function getLeads() { return loadFile('leads.json'); }

function saveLead(lead) {
  const leads = getLeads();
  const entry = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...lead };
  leads.unshift(entry);
  saveFile('leads.json', leads.slice(0, 5000));
  return entry;
}

// --- Calls ---
function getCalls() { return loadFile('calls.json'); }

function saveCall(call) {
  const calls = getCalls();
  const entry = { id: crypto.randomUUID(), timestamp: new Date().toISOString(), ...call };
  calls.unshift(entry);
  saveFile('calls.json', calls.slice(0, 5000));
  return entry;
}

// --- API Keys ---
function getApiKeys() { return loadFile('api-keys.json'); }

function createApiKey(label) {
  const keys = getApiKeys();
  const key = { id: crypto.randomUUID(), key: 'sk_' + crypto.randomBytes(24).toString('hex'), label, createdAt: new Date().toISOString(), active: true };
  keys.push(key);
  saveFile('api-keys.json', keys);
  return key;
}

function validateApiKey(raw) {
  return getApiKeys().find(k => k.key === raw && k.active) || null;
}

function revokeApiKey(id) {
  const keys = getApiKeys().map(k => k.id === id ? { ...k, active: false } : k);
  saveFile('api-keys.json', keys);
}

// --- Webhooks ---
function getWebhooks() { return loadFile('webhooks.json'); }

function addWebhook({ url, events, label }) {
  const hooks = getWebhooks();
  const hook = { id: crypto.randomUUID(), url, events: events || ['lead.created', 'call.completed'], label: label || '', createdAt: new Date().toISOString(), active: true };
  hooks.push(hook);
  saveFile('webhooks.json', hooks);
  return hook;
}

function removeWebhook(id) {
  saveFile('webhooks.json', getWebhooks().filter(h => h.id !== id));
}

async function fireWebhooks(event, payload) {
  const hooks = getWebhooks().filter(h => h.active && h.events.includes(event));
  for (const hook of hooks) {
    const body = JSON.stringify({ event, payload, timestamp: new Date().toISOString() });
    const sig = crypto.createHmac('sha256', hook.id).update(body).digest('hex');
    fetch(hook.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-SoCal-Signature': sig },
      body,
    }).catch(err => console.error(`[webhook] ${hook.url} failed:`, err.message));
  }
}

module.exports = { getLeads, saveLead, getCalls, saveCall, getApiKeys, createApiKey, validateApiKey, revokeApiKey, getWebhooks, addWebhook, removeWebhook, fireWebhooks };
