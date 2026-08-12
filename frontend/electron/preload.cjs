const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('wrhDesktop', {
  connectVpn: (credentials) => ipcRenderer.invoke('connect-openvpn', credentials),
  restoreVpn: (lease) => ipcRenderer.invoke('inspect-openvpn', lease),
  inspectVpn: (lease) => ipcRenderer.invoke('inspect-openvpn', lease),
  desktopStatus: () => ipcRenderer.invoke('openvpn-status'),
  prepareDesktop: () => ipcRenderer.invoke('prepare-openvpn'),
  disconnectVpn: () => ipcRenderer.invoke('disconnect-openvpn'),
  pingHost: (host) => ipcRenderer.invoke('ping-host', host),
  chooseGame: () => ipcRenderer.invoke('choose-game'),
  launchGame: (gamePath) => ipcRenderer.invoke('launch-game', gamePath),
})
