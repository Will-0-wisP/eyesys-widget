const { contextBridge, ipcRenderer } = require('electron');

// subscribe to a main-process message; returns an unsubscribe function
const on = (channel, cb) => {
  const handler = (_event, ...args) => cb(...args);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('eyesysAPI', {
  // config + data
  getConfig: () => ipcRenderer.invoke('get-config'),
  saveConfig: (partial) => ipcRenderer.invoke('save-config', partial),
  getCpu: () => ipcRenderer.invoke('get-cpu'),
  listDir: () => ipcRenderer.invoke('list-dir'),
  openPath: (p) => ipcRenderer.invoke('open-path', p),
  chooseFolder: () => ipcRenderer.invoke('choose-folder'),
  listCustomEyes: () => ipcRenderer.invoke('list-custom-eyes'),
  openEyesFolder: () => ipcRenderer.invoke('open-eyes-folder'),
  startDrag: (filePath) => ipcRenderer.send('start-drag', filePath),

  // icon window -> panel lifecycle
  preparePanel: () => ipcRenderer.send('panel:prepare'),
  showContextMenu: () => ipcRenderer.send('show-context-menu'),
  openPanel: () => ipcRenderer.invoke('panel:open'),
  closePanel: () => ipcRenderer.send('panel:close'),
  dragStart: () => ipcRenderer.send('drag-start'),
  dragMove: (dx, dy) => ipcRenderer.send('drag-move', dx, dy),
  dragEnd: () => ipcRenderer.send('drag-end'),

  // panel window
  panelReady: () => ipcRenderer.send('panel:ready'),
  resizeStart: () => ipcRenderer.invoke('panel:resize-start'),
  resizeEnd: (w, h) => ipcRenderer.send('panel:resize-end', w, h),

  // events from main
  onCpu: (cb) => on('cpu', cb),
  onConfig: (cb) => on('config', cb),
  onPanelClosed: (cb) => on('panel-closed', cb),
  onPanelOpened: (cb) => on('panel-opened', cb),
  onPanelOpen: (cb) => on('panel-open', cb),
  onPanelShown: (cb) => on('panel-shown', cb),
  onPanelHide: (cb) => on('panel-hide', cb),
  onPanelLayout: (cb) => on('panel-layout', cb),
  onPanelBackdrop: (cb) => on('panel-backdrop', cb),
  onOpenSettings: (cb) => on('open-settings', cb),
  onDesktopState: (cb) => on('desktop-state', cb)
});
