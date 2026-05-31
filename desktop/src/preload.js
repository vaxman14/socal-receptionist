'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('setupAPI', {
  connect: (creds) => ipcRenderer.invoke('setup-connect', creds),
});

contextBridge.exposeInMainWorld('desktopAPI', {
  onTicketUpdate: (cb) => { ipcRenderer.on('ticket-update', (_e, payload) => cb(payload)); },
  onActivityLog: (cb) => { ipcRenderer.on('activity-log', (_e, entry) => cb(entry)); },
  submitQuickLog: (data) => ipcRenderer.invoke('submit-quick-log', data),
  getRecentActivity: (n = 5) => ipcRenderer.invoke('get-recent-activity', n),
});
