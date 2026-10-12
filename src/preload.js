const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('kover', {
  ready: () => ipcRenderer.send('rug:ready'),
  ignoreMouse: (ignore) => ipcRenderer.send('rug:ignore', ignore),
  dragStart: () => ipcRenderer.send('rug:drag-start'),
  dragEnd: () => ipcRenderer.send('rug:drag-end'),
  setAngle: (deg) => ipcRenderer.send('rug:angle', deg),
  zoom: (factor) => ipcRenderer.send('rug:zoom', factor),
  menu: () => ipcRenderer.send('rug:menu'),
  onSet: (cb) => ipcRenderer.on('rug:set', (_e, data) => cb(data)),
});
