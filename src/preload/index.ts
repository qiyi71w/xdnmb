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
  links: {
    openExternal: (input) => ipcRenderer.invoke(IpcChannel.openExternal, input)
  },
  app: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.getStatus)
  }
}

contextBridge.exposeInMainWorld('xidao', api)
