import { contextBridge, ipcRenderer } from 'electron'
import { IpcChannel, type XidaoApi } from '../shared/api'

// Named operations only: no generic invoke/send, no Electron objects, URLs, SQL or file access.
const api: XidaoApi = {
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
  search: {
    run: (input) => ipcRenderer.invoke(IpcChannel.runSearch, input),
    page: (input) => ipcRenderer.invoke(IpcChannel.searchPage, input),
    cancel: (input) => ipcRenderer.invoke(IpcChannel.cancelSearch, input),
    close: (input) => ipcRenderer.invoke(IpcChannel.closeSearch, input),
    openSite: () => ipcRenderer.invoke(IpcChannel.openSearchSite)
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
  app: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.getStatus)
  }
}

contextBridge.exposeInMainWorld('xidao', api)
