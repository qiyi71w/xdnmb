import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type XidaoApi } from '../shared/api'

// Named operations only: no generic invoke/send, no Electron objects, URLs, SQL or file access.
const api: XidaoApi = {
  content: {
    list: (input) => ipcRenderer.invoke(IpcChannel.listRetained, input),
    favorite: (input) => ipcRenderer.invoke(IpcChannel.favorite, input),
    isFavorite: (input) => ipcRenderer.invoke(IpcChannel.isFavorite, input),
    clearHistory: (input) => ipcRenderer.invoke(IpcChannel.clearHistory, input),
    usage: () => ipcRenderer.invoke(IpcChannel.contentUsage),
    setCacheLimit: (input) => ipcRenderer.invoke(IpcChannel.setCacheLimit, input),
    clearCache: () => ipcRenderer.invoke(IpcChannel.clearCache),
    saveOffline: (input) => ipcRenderer.invoke(IpcChannel.saveOffline, input),
    offlineStatus: (input) => ipcRenderer.invoke(IpcChannel.offlineStatus, input),
    cancelOffline: (input) => ipcRenderer.invoke(IpcChannel.cancelOffline, input),
    holdReader: (input) => ipcRenderer.invoke(IpcChannel.holdContentReader, input),
    releaseReader: (input) => ipcRenderer.invoke(IpcChannel.releaseContentReader, input)
  },
  reading: {
    loadDirectory: (input) => ipcRenderer.invoke(IpcChannel.loadDirectory, input),
    readFeedPage: (input) => ipcRenderer.invoke(IpcChannel.readFeedPage, input),
    readThreadPage: (input) => ipcRenderer.invoke(IpcChannel.readThreadPage, input),
    locateThreadEnd: (input) => ipcRenderer.invoke(IpcChannel.locateThreadEnd, input),
    cancel: (input) => ipcRenderer.invoke(IpcChannel.cancel, input)
  },
  quotes: {
    preview: (input) => ipcRenderer.invoke(IpcChannel.previewQuote, input),
    locate: (input) => ipcRenderer.invoke(IpcChannel.locateQuote, input)
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
  drafts: {
    list: () => ipcRenderer.invoke(IpcChannel.listDrafts),
    save: (input) => ipcRenderer.invoke(IpcChannel.saveDraft, input),
    delete: (input) => ipcRenderer.invoke(IpcChannel.deleteDraft, input),
    attachImage: (input) => ipcRenderer.invoke(IpcChannel.attachDraftImage, input),
    holdAttachment: (input) => ipcRenderer.invoke(IpcChannel.holdDraftAttachment, input),
    releaseEditor: (input) => ipcRenderer.invoke(IpcChannel.releaseEditor, input)
  },
  posting: {
    identityFor: (input) => ipcRenderer.invoke(IpcChannel.postingIdentityFor, input),
    selectThreadIdentity: (input) => ipcRenderer.invoke(IpcChannel.selectThreadIdentity, input)
  },
  app: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.getStatus)
  }
}

contextBridge.exposeInMainWorld('xidao', api)
