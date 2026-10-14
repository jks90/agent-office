// Puente mínimo de la burbuja: la página solo puede pedir tamaño, ponerse al frente y cerrarse.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aoOverlay', {
  resize: (width, height) => ipcRenderer.send('overlay:resize', { width, height }),
  attention: () => ipcRenderer.send('overlay:attention'),
  close: () => ipcRenderer.send('overlay:close'),
});
