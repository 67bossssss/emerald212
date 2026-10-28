const { contextBridge, ipcRenderer, webFrame } = require('electron');
contextBridge.exposeInMainWorld('api', {
  call: (c, ...a) => ipcRenderer.invoke(c, ...a),
  onProgress: cb => ipcRenderer.on('progress', (_, d) => cb(d)),
  zoom: f => webFrame.setZoomFactor(f)
});
