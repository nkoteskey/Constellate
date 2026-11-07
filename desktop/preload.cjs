// The bridge between the Constellate app (the local web page) and this desktop app. The main
// process answers only when the request comes from the local app's own address.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('constellateDesktop', {
  status: () => ipcRenderer.invoke('desktop:status'),
  contribute: (on) => ipcRenderer.invoke('desktop:contribute', on),
  setModel: (model, verifier) => ipcRenderer.invoke('desktop:setModel', model, verifier),
  openAtLogin: (on) => ipcRenderer.invoke('desktop:openAtLogin', on),
  getOllama: () => ipcRenderer.invoke('desktop:getOllama'),
  pull: (model) => ipcRenderer.invoke('desktop:pull', model),
  onPullProgress: (fn) => { const h = (_e, p) => fn(p); ipcRenderer.on('desktop:pull-progress', h); return () => ipcRenderer.off('desktop:pull-progress', h); },
  connectAgent: (id) => ipcRenderer.invoke('desktop:connectAgent', id),
  disconnectAgent: (id) => ipcRenderer.invoke('desktop:disconnectAgent', id),
  linkX0x: (browserId) => ipcRenderer.invoke('desktop:linkX0x', browserId),
});
