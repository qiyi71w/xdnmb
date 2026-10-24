import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type XidaoApi } from '../shared/api'

// Named operations only: no generic invoke/send, no Electron objects, URLs, SQL or file access.
const api: XidaoApi = {
  subscriptions: {
    getOverview: () => ipcRenderer.invoke(IpcChannel.subscriptionOverview),
    configureApp: (input) => ipcRenderer.invoke(IpcChannel.subscriptionConfigureApp, input),
    selectSource: (input) => ipcRenderer.invoke(IpcChannel.subscriptionSelectSource, input),
    getObservation: (input) => ipcRenderer.invoke(IpcChannel.subscriptionObservation, input),
    read: (input) => ipcRenderer.invoke(IpcChannel.subscriptionRead, input),
    change: (input) => ipcRenderer.invoke(IpcChannel.subscriptionChange, input),
    getOperations: () => ipcRenderer.invoke(IpcChannel.subscriptionOperations),
    reconcile: (input) => ipcRenderer.invoke(IpcChannel.subscriptionReconcile, input),
    getMergeSources: () => ipcRenderer.invoke(IpcChannel.subscriptionMergeSources),
    previewSync: (input) => ipcRenderer.invoke(IpcChannel.subscriptionPreviewSync, input),
    previewMerge: (input) => ipcRenderer.invoke(IpcChannel.subscriptionPreviewMerge, input),
    executePlan: (input) => ipcRenderer.invoke(IpcChannel.subscriptionExecutePlan, input),
    getPlans: () => ipcRenderer.invoke(IpcChannel.subscriptionPlans),
    cancel: (input) => ipcRenderer.invoke(IpcChannel.subscriptionCancel, input)
  },
  reading: {
    loadDirectory: (input) => ipcRenderer.invoke(IpcChannel.loadDirectory, input),
    readFeedPage: (input) => ipcRenderer.invoke(IpcChannel.readFeedPage, input),
    readThreadPage: (input) => ipcRenderer.invoke(IpcChannel.readThreadPage, input),
    locateThreadEnd: (input) => ipcRenderer.invoke(IpcChannel.locateThreadEnd, input),
    cancel: (input) => ipcRenderer.invoke(IpcChannel.cancel, input)
  },
  readingState: {
    get: (input) => ipcRenderer.invoke(IpcChannel.getReadingState, input),
    setMode: (input) => ipcRenderer.invoke(IpcChannel.setReadingMode, input),
    savePosition: (input) => ipcRenderer.invoke(IpcChannel.saveReadingPosition, input),
    markRead: (input) => ipcRenderer.invoke(IpcChannel.markRead, input),
    recordVisit: (input) => ipcRenderer.invoke(IpcChannel.recordVisit, input)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannel.getSettings),
    update: (input) => ipcRenderer.invoke(IpcChannel.updateSettings, input)
  },
  links: {
    openExternal: (input) => ipcRenderer.invoke(IpcChannel.openExternal, input)
  },
  images: {
    load: (input) => ipcRenderer.invoke(IpcChannel.loadImage, input),
    cancel: (input) => ipcRenderer.invoke(IpcChannel.cancelImage, input),
    releaseView: (input) => ipcRenderer.invoke(IpcChannel.releaseImageView, input),
    saveOriginal: (input) => ipcRenderer.invoke(IpcChannel.saveOriginalImage, input)
  },
  identities: {
    getOverview: () => ipcRenderer.invoke(IpcChannel.identityOverview),
    importExport: (input) => ipcRenderer.invoke(IpcChannel.identityImportExport, input),
    importRaw: (input) => ipcRenderer.invoke(IpcChannel.identityImportRaw, input),
    rename: (input) => ipcRenderer.invoke(IpcChannel.identityRename, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.identityRemove, input),
    select: (input) => ipcRenderer.invoke(IpcChannel.identitySelect, input)
  },
  app: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.getStatus)
  }
}

contextBridge.exposeInMainWorld('xidao', api)
