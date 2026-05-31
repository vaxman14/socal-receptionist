'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopAPI', {
  // Called when Supabase realtime pushes a ticket change
  onTicketUpdate: (cb) => {
    ipcRenderer.on('ticket-update', (_event, payload) => cb(payload));
  },

  // Called every 60 s when the screen tracker captures active app/window
  onActivityLog: (cb) => {
    ipcRenderer.on('activity-log', (_event, entry) => cb(entry));
  },

  // Submit a quick-log entry (manual time entry from the floating window)
  submitQuickLog: (data) => {
    ipcRenderer.invoke('submit-quick-log', data);
  },

  // Request the last N screen-tracker entries from main process
  getRecentActivity: (n = 5) => {
    return ipcRenderer.invoke('get-recent-activity', n);
  },
});
