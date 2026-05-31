'use strict';

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  ipcMain,
  safeStorage,
} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
const { autoUpdater } = require('electron-updater');
const screenTracker = require('./screen-tracker');

// ── Config persistence ───────────────────────────────────────────────────────
const CONFIG_DIR = path.join(os.homedir(), '.socal-desktop');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// Baked-in V3 Supabase endpoint — users just log in with email/password
const SUPABASE_URL = 'https://xcngpfeuvvcsxgwyukch.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhjbmdwZmV1dnZjc3hnd3l1a2NoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODAyMDI5MjksImV4cCI6MjA5NTc3ODkyOX0.HCFgA6MNWH_as3i9YSOH6liyszTfHxCIpHqiqg53N4c';

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (cfg._tokenEncrypted && cfg.accessToken) {
        if (!safeStorage.isEncryptionAvailable()) {
          // Encrypted token exists but safeStorage is gone — force re-login.
          console.warn('[config] safeStorage unavailable; clearing encrypted token');
          return null;
        }
        cfg.accessToken = safeStorage.decryptString(Buffer.from(cfg.accessToken, 'base64'));
        delete cfg._tokenEncrypted;
      }
      return cfg;
    }
  } catch {}
  return null;
}

function saveConfig(cfg) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  if (cfg.accessToken && !safeStorage.isEncryptionAvailable()) {
    // Fail closed: never write a plaintext token. Require re-login next launch.
    const stored = { ...cfg };
    delete stored.accessToken;
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(stored, null, 2));
    console.warn('[config] safeStorage unavailable; access token not persisted');
    return;
  }
  const stored = { ...cfg };
  if (cfg.accessToken) {
    stored.accessToken = safeStorage.encryptString(cfg.accessToken).toString('base64');
    stored._tokenEncrypted = true;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(stored, null, 2));
}

// ── Prevent second instance ──────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// ── State ────────────────────────────────────────────────────────────────────
let tray = null;
let quickLogWin = null;
let setupWin = null;
let todayMinutes = 0;
let supabase = null;
let realtimeChannel = null;
let tenantId = null;

// ── Tray icon (inline SVG) ───────────────────────────────────────────────────
const TRAY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
  <circle cx="11" cy="11" r="10" fill="#1e3a5f" stroke="#4a9eff" stroke-width="1.5"/>
  <text x="11" y="15" font-size="11" font-family="Arial" font-weight="bold"
        text-anchor="middle" fill="#ffffff">T</text>
</svg>`;

function makeTrayIcon() {
  const b64 = Buffer.from(TRAY_ICON_SVG).toString('base64');
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${b64}`);
}

function fmtHours(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

function buildTrayMenu() {
  return Menu.buildFromTemplate([
    { label: 'Quick Log  (⌘⇧T)', click: () => showQuickLog() },
    { label: `Today: ${fmtHours(todayMinutes)} tracked`, enabled: false },
    { type: 'separator' },
    { label: 'Check for Updates', click: () => autoUpdater.checkForUpdatesAndNotify() },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuitting = true; app.quit(); } },
  ]);
}

function refreshTray() {
  if (!tray) return;
  tray.setToolTip(`SoCal Receptionist — Today: ${fmtHours(todayMinutes)}`);
  tray.setContextMenu(buildTrayMenu());
}

// ── Quick Log window ─────────────────────────────────────────────────────────
function createQuickLogWindow() {
  quickLogWin = new BrowserWindow({
    width: 400,
    height: 340,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    resizable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  quickLogWin.loadFile(path.join(__dirname, 'renderer', 'quicklog.html'));
  quickLogWin.on('close', (e) => { if (!app.isQuitting) { e.preventDefault(); quickLogWin.hide(); } });
  quickLogWin.on('blur', () => quickLogWin.hide());
}

function showQuickLog() {
  if (!quickLogWin) createQuickLogWindow();
  if (quickLogWin.isVisible()) { quickLogWin.hide(); return; }
  const { screen } = require('electron');
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  quickLogWin.setPosition(Math.round(width / 2 - 200), 60);
  quickLogWin.show();
  quickLogWin.focus();
}

// ── Setup / login window ─────────────────────────────────────────────────────
function showSetupWindow() {
  setupWin = new BrowserWindow({
    width: 460,
    height: 420,
    resizable: false,
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  setupWin.loadFile(path.join(__dirname, 'renderer', 'setup.html'));
  setupWin.on('closed', () => { setupWin = null; });
}

// ── Supabase ─────────────────────────────────────────────────────────────────
function initSupabase(accessToken) {
  supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
    realtime: { params: { eventsPerSecond: 10 } },
  });

  const filter = tenantId ? `tenant_id=eq.${tenantId}` : undefined;
  realtimeChannel = supabase
    .channel('time_tickets_changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'time_tickets', ...(filter ? { filter } : {}) }, (payload) => {
      if (payload.eventType === 'INSERT' && payload.new?.billable_mins) {
        todayMinutes += payload.new.billable_mins;
        refreshTray();
      }
      if (quickLogWin && !quickLogWin.isDestroyed()) {
        quickLogWin.webContents.send('ticket-update', payload);
      }
    })
    .subscribe((status) => console.log('[supabase] realtime:', status));
}

async function loginAndStart({ email, password }) {
  const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { auth: { persistSession: false } });
  const { data, error } = await anonClient.auth.signInWithPassword({ email, password });
  if (error) return { error: error.message };

  const accessToken = data.session.access_token;
  const userId = data.user.id;

  // Resolve tenant
  const { data: tenant } = await anonClient.from('tenants')
    .select('id')
    .eq('owner_user_id', userId)
    .single();

  tenantId = tenant?.id || null;
  saveConfig({ accessToken, userId, tenantId, email });
  initSupabase(accessToken);

  if (setupWin) { setupWin.close(); }
  finishBoot();
  return { error: null };
}

// ── Boot ─────────────────────────────────────────────────────────────────────
function finishBoot() {
  createQuickLogWindow();

  const shortcut = process.platform === 'darwin' ? 'Command+Shift+T' : 'Ctrl+Shift+T';
  globalShortcut.register(shortcut, () => showQuickLog());

  screenTracker.start((entry) => {
    if (quickLogWin && !quickLogWin.isDestroyed()) quickLogWin.webContents.send('activity-log', entry);
  });

  autoUpdater.checkForUpdatesAndNotify();
  refreshTray();
}

// ── IPC ───────────────────────────────────────────────────────────────────────
function registerIpcHandlers() {
  ipcMain.handle('setup-connect', async (_event, creds) => loginAndStart(creds));

  ipcMain.handle('submit-quick-log', async (_event, data) => {
    if (!supabase) return { error: 'Not connected' };
    const { error } = await supabase.from('time_tickets').insert({
      tenant_id: tenantId || null,
      description: data.description,
      billable_mins: Number(data.durationMins) || 0,
      activity: data.activity || 'phone_call',
      status: 'accepted',
    });
    if (!error) { todayMinutes += Number(data.durationMins) || 0; refreshTray(); }
    return { error: error?.message || null };
  });

  ipcMain.handle('get-recent-activity', (_event, n = 5) => screenTracker.getRecentEntries(n));
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.hide();

  tray = new Tray(makeTrayIcon());
  tray.on('click', () => showQuickLog());
  refreshTray();

  registerIpcHandlers();

  const config = loadConfig();
  if (config?.accessToken) {
    tenantId = config.tenantId || null;
    initSupabase(config.accessToken);
    finishBoot();
  } else {
    showSetupWindow();
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  screenTracker.stop();
  if (realtimeChannel) supabase?.removeChannel(realtimeChannel);
});

app.on('window-all-closed', (e) => { if (!app.isQuitting) e.preventDefault(); });
app.on('second-instance', () => showQuickLog());
