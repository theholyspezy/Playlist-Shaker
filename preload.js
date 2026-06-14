const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('electronAPI', {
  // Config
  getConfig: (key) => ipcRenderer.invoke('get-config', key),
  setConfig: (key, value) => ipcRenderer.invoke('set-config', key, value),
  getAllConfig: () => ipcRenderer.invoke('get-all-config'),

  // Auth
  startAuth: () => ipcRenderer.invoke('start-auth'),
  isAuthenticated: () => ipcRenderer.invoke('is-authenticated'),
  logout: () => ipcRenderer.invoke('logout'),
  onAuthComplete: (callback) => {
    ipcRenderer.on('auth-complete', (_, data) => callback(data))
  },

  // Spotify API proxy
  spotifyGet: (endpoint) =>
    ipcRenderer.invoke('spotify-request', { method: 'GET', endpoint, body: null }),
  spotifyPost: (endpoint, body) =>
    ipcRenderer.invoke('spotify-request', { method: 'POST', endpoint, body }),
  spotifyPut: (endpoint, body) =>
    ipcRenderer.invoke('spotify-request', { method: 'PUT', endpoint, body }),
  spotifyDelete: (endpoint, body) =>
    ipcRenderer.invoke('spotify-request', { method: 'DELETE', endpoint, body }),

  // Admin
  checkPassword: (password) => ipcRenderer.invoke('check-password', password),
  setAdminPassword: (password) => ipcRenderer.invoke('set-admin-password', password),

  // Window controls
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowMaximize: () => ipcRenderer.invoke('window-maximize'),
  windowClose: () => ipcRenderer.invoke('window-close'),

  // Auto-start Spotify on a hidden virtual desktop
  autoStartSpotify: () => ipcRenderer.invoke('auto-start-spotify'),
})
