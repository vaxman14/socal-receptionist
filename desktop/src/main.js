'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  globalShortcut,
  ipcMain,
  shell,
} = require('electron');
const path = require('path');
const os = require('os');
const { createClient } = require('@supabase/supabase-js');
const screenTracker = require('./screen-tracker');

// ── Prevent second instance ─────────────────────────────────────────────────
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) { app.quit(); }

// ── State ────────────────────────────────────────────────────────────────────
let tray = null;
let quickLogWin = null;
let todayMinutes = 0;
let supabase = null;
let realtimeChannel = null;

// ── Tray icon (inline SVG → base64) ─────────────────────────────────────────
const TRAY_ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">
  <circle cx="11" cy="11" r="10" fill="#1e3a5f" stroke="#4a9eff" stroke-width="1.5"/>
  <text x="11" y="15" font-size="11" font-family="Arial" font-weight="bold"
        text-anchor="middle" fill="#ffffff">T</text>
</svg>`;

function makeTrayIcon() {
  const b64 = Buffer.from(TRAY_ICON_SVG).toString('base64');
  const dataUrl = `data:image/svg+xml;base64,${b64}`;
  return nativeImage.createFromDataURL(dataUrl);
}

// ── Format hours for tray tooltip / menu ────────────────────────────────────
function fmtHours(mins) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h ${m}m`;
}

// ── Build / refresh tray context menu ───────────────────────────────────────
function buildTrayMenu() {
  return Menu.buildFromTemplate([
    {
      label: 'Open Quick Log',
      click: () => showQuickLog(),
    },
    {
      label: `Today: ${fmtHours(todayMinutes)} tracked`,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: 'Quit',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
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

  // Hide to tray instead of closing
  quickLogWin.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      quickLogWin.hide();
    }
  });

  quickLogWin.on('blur', () => {
    // Auto-hide when clicking away
    quickLogWin.hide();
  });
}

function showQuickLog() {
  if (!quickLogWin) createQuickLogWindow();
  if (quickLogWin.isVisible()) {
    quickLogWin.hide();
    return;
  }

  // Position near top-center of primary display
  const { screen } = require('electron');
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  quickLogWin.setPosition(Math.round(width / 2 - 200), 60);
  quickLogWin.show();
  quickLogWin.focus();
}

// ── Supabase realtime ────────────────────────────────────────────────────────
function connectSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  const tenantId = process.env.TENANT_ID;

  if (!url || !key) {
    console.warn('[supabase] SUPABASE_URL / SUPABASE_ANON_KEY not set — realtime disabled');
    return;
  }

  supabase = createClient(url, key, {
    auth: { persistSession: false },
    realtime: { params: { eventsPerSecond: 10 } },
  });

  const filter = tenantId ? `tenant_id=eq.${tenantId}` : undefined;

  realtimeChannel = supabase
    .channel('time_tickets_changes')
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: 'time_tickets',
        ...(filter ? { filter } : {}),
      },
      (payload) => {
        // Accumulate today's minutes from INSERT/UPDATE
        if (payload.eventType === 'INSERT' && payload.new?.duration_minutes) {
          todayMinutes += payload.new.duration_minutes;
          refreshTray();
        }
        // Forward to renderer
        if (quickLogWin && !quickLogWin.isDestroyed()) {
          quickLogWin.webContents.send('ticket-update', payload);
        }
      }
    )
    .subscribe((status) => {
      console.log('[supabase] realtime status:', status);
    });
}

// ── IPC handlers ─────────────────────────────────────────────────────────────
function registerIpcHandlers() {
  ipcMain.handle('submit-quick-log', async (_event, data) => {
    if (!supabase) return { error: 'Supabase not connected' };
    const tenantId = process.env.TENANT_ID;
    const { error } = await supabase.from('time_tickets').insert({
      tenant_id: tenantId || null,
      client_matter: data.clientMatter,
      description: data.description,
      duration_minutes: Number(data.durationMins) || 0,
      logged_at: new Date().toISOString(),
      source: 'desktop-manual',
    });
    if (!error) {
      todayMinutes += Number(data.durationMins) || 0;
      refreshTray();
    }
    return { error: error?.message || null };
  });

  ipcMain.handle('get-recent-activity', (_event, n = 5) => {
    return screenTracker.getRecentEntries(n);
  });
}

// ── App lifecycle ─────────────────────────────────────────────────────────────
app.whenReady().then(() => {
  // No dock icon on macOS
  if (process.platform === 'darwin') {
    app.dock.hide();
  }

  // Tray
  tray = new Tray(makeTrayIcon());
  refreshTray();
  tray.on('click', () => showQuickLog());

  // Quick Log window (preload)
  createQuickLogWindow();

  // Global shortcut
  const shortcut = process.platform === 'darwin' ? 'Command+Shift+T' : 'Ctrl+Shift+T';
  globalShortcut.register(shortcut, () => showQuickLog());

  // IPC
  registerIpcHandlers();

  // Supabase
  connectSupabase();

  // Screen tracker
  screenTracker.start((entry) => {
    if (quickLogWin && !quickLogWin.isDestroyed()) {
      quickLogWin.webContents.send('activity-log', entry);
    }
    console.log('[activity]', entry.ts, entry.app, '—', entry.title);
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  screenTracker.stop();
  if (realtimeChannel) supabase?.removeChannel(realtimeChannel);
});

// macOS: prevent full quit when all windows closed
app.on('window-all-closed', (e) => {
  if (!app.isQuitting) e.preventDefault();
});

app.on('second-instance', () => {
  showQuickLog();
});
