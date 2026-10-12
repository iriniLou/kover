const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kover', {
  init: () => ipcRenderer.invoke('ov:init'),
  save: (rugs) => ipcRenderer.send('ov:save', rugs),
  ignoreMouse: (ignore) => ipcRenderer.send('ov:ignore', ignore),
  menu: (id) => ipcRenderer.send('ov:menu', id),
  onAction: (cb) => ipcRenderer.on('ov:action', (_e, msg) => cb(msg)),
});
