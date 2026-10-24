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
  publication: {
    submit: (input) => ipcRenderer.invoke(IpcChannel.submitPublication, input),
    resolvePrompt: (input) => ipcRenderer.invoke(IpcChannel.resolvePoPrompt, input),
    listAttempts: () => ipcRenderer.invoke(IpcChannel.listPublications),
    getAttempt: (input) => ipcRenderer.invoke(IpcChannel.getPublication, input),
    listOwnPosts: () => ipcRenderer.invoke(IpcChannel.listOwnPosts),
    addOwnPost: (input) => ipcRenderer.invoke(IpcChannel.addOwnPost, input),
    getPoWarning: () => ipcRenderer.invoke(IpcChannel.getPoWarning),
    setPoWarning: (input) => ipcRenderer.invoke(IpcChannel.setPoWarning, input)
  },
  app: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.getStatus)
  }
}

contextBridge.exposeInMainWorld('xidao', api)
