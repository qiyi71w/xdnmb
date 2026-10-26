import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannel, LIFECYCLE_REQUEST_CHANNEL, type XidaoApi } from '../shared/api'
import type { LifecycleRequest } from '../shared/lifecycle'
import { REMINDERS_CHANGED_CHANNEL, REMINDERS_OPEN_CHANNEL } from '../shared/reminders'

// A notification can create a window before React has mounted its listener. Keep the intent in
// preload, not an arbitrary timeout, until a subscriber can open the in-app list.
let pendingReminderOpen = false
const reminderOpenListeners = new Set<() => void>()
ipcRenderer.on(REMINDERS_OPEN_CHANNEL, () => {
  if (reminderOpenListeners.size === 0) pendingReminderOpen = true
  else {
    pendingReminderOpen = false
    for (const listener of reminderOpenListeners) listener()
  }
})

// Named operations only: no generic invoke/send, no Electron objects, URLs, SQL or file access.
const api: XidaoApi = {
  blocks: {
    list: () => ipcRenderer.invoke(IpcChannel.listBlocks),
    set: (input) => ipcRenderer.invoke(IpcChannel.setBlock, input)
  },
  reminders: {
    getRules: (input) => ipcRenderer.invoke(IpcChannel.reminderGetRules, input),
    setRule: (input) => ipcRenderer.invoke(IpcChannel.reminderSetRule, input),
    overview: () => ipcRenderer.invoke(IpcChannel.reminderOverview),
    check: () => ipcRenderer.invoke(IpcChannel.reminderCheck),
    cancel: () => ipcRenderer.invoke(IpcChannel.reminderCancel),
    closeForThreads: (input) => ipcRenderer.invoke(IpcChannel.reminderCloseForThreads, input),
    onChanged(listener) {
      const receive = () => listener()
      ipcRenderer.on(REMINDERS_CHANGED_CHANNEL, receive)
      return () => { ipcRenderer.removeListener(REMINDERS_CHANGED_CHANNEL, receive) }
    },
    onOpenList(listener) {
      reminderOpenListeners.add(listener)
      if (pendingReminderOpen) queueMicrotask(() => {
        if (pendingReminderOpen && reminderOpenListeners.has(listener)) {
          pendingReminderOpen = false
          listener()
        }
      })
      return () => { reminderOpenListeners.delete(listener) }
    }
  },
  search: {
    start: (input) => ipcRenderer.invoke(IpcChannel.searchStart, input),
    next: (input) => ipcRenderer.invoke(IpcChannel.searchNext, input),
    cancel: (input) => ipcRenderer.invoke(IpcChannel.searchCancel, input),
    fetchThread: (input) => ipcRenderer.invoke(IpcChannel.searchFetchThread, input),
    fetchStatus: (input) => ipcRenderer.invoke(IpcChannel.searchFetchStatus, input),
    rebuild: (input) => ipcRenderer.invoke(IpcChannel.searchRebuild, input),
    threadMetadata: (input) => ipcRenderer.invoke(IpcChannel.searchThreadMetadata, input)
  },
  content: {
    list: (input) => ipcRenderer.invoke(IpcChannel.listRetained, input),
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
  subscriptions: {
    getOverview: () => ipcRenderer.invoke(IpcChannel.subscriptionOverview),
    configureApp: (input) => ipcRenderer.invoke(IpcChannel.subscriptionConfigureApp, input),
    revealAppUuid: () => ipcRenderer.invoke(IpcChannel.subscriptionRevealApp),
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
  quotes: {
    preview: (input) => ipcRenderer.invoke(IpcChannel.previewQuote, input),
    locate: (input) => ipcRenderer.invoke(IpcChannel.locateQuote, input)
  },
  onlineSearch: {
    run: (input) => ipcRenderer.invoke(IpcChannel.runOnlineSearch, input),
    page: (input) => ipcRenderer.invoke(IpcChannel.onlineSearchPage, input),
    cancel: (input) => ipcRenderer.invoke(IpcChannel.cancelOnlineSearch, input),
    close: (input) => ipcRenderer.invoke(IpcChannel.closeOnlineSearch, input),
    openSite: () => ipcRenderer.invoke(IpcChannel.openOnlineSearchSite)
  },
  readingState: {
    get: (input) => ipcRenderer.invoke(IpcChannel.getReadingState, input),
    setMode: (input) => ipcRenderer.invoke(IpcChannel.setReadingMode, input),
    savePosition: (input) => ipcRenderer.invoke(IpcChannel.saveReadingPosition, input),
    recordVisit: (input) => ipcRenderer.invoke(IpcChannel.recordVisit, input)
  },
  settings: {
    get: () => ipcRenderer.invoke(IpcChannel.getSettings),
    update: (input) => ipcRenderer.invoke(IpcChannel.updateSettings, input)
  },
  theme: {
    import: () => ipcRenderer.invoke(IpcChannel.importTheme),
    export: () => ipcRenderer.invoke(IpcChannel.exportTheme)
  },
  view: {
    getZoom: () => ipcRenderer.invoke(IpcChannel.getZoom),
    zoom: (input) => ipcRenderer.invoke(IpcChannel.zoom, input),
    updateTitleBar: (input) => ipcRenderer.invoke(IpcChannel.updateTitleBar, input)
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
  account: {
    getOverview: () => ipcRenderer.invoke(IpcChannel.accountOverview),
    login: () => ipcRenderer.invoke(IpcChannel.accountLogin),
    list: () => ipcRenderer.invoke(IpcChannel.accountList),
    importSelected: (input) => ipcRenderer.invoke(IpcChannel.accountImport, input),
    forget: () => ipcRenderer.invoke(IpcChannel.accountForget)
  },
  identities: {
    getOverview: () => ipcRenderer.invoke(IpcChannel.identityOverview),
    importExport: (input) => ipcRenderer.invoke(IpcChannel.identityImportExport, input),
    importRaw: (input) => ipcRenderer.invoke(IpcChannel.identityImportRaw, input),
    rename: (input) => ipcRenderer.invoke(IpcChannel.identityRename, input),
    setCookieId: (input) => ipcRenderer.invoke(IpcChannel.identitySetCookieId, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.identityRemove, input),
    select: (input) => ipcRenderer.invoke(IpcChannel.identitySelect, input),
    reorder: (input) => ipcRenderer.invoke(IpcChannel.identityReorder, input)
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
    getPoWarning: () => ipcRenderer.invoke(IpcChannel.getPoWarning),
    setPoWarning: (input) => ipcRenderer.invoke(IpcChannel.setPoWarning, input)
  },
  lifecycle: {
    onRequest(listener) {
      // Only the request object crosses; never the Electron event or sender.
      const handler = (_event: IpcRendererEvent, request: LifecycleRequest) => listener(request)
      ipcRenderer.on(LIFECYCLE_REQUEST_CHANNEL, handler)
      return () => {
        ipcRenderer.removeListener(LIFECYCLE_REQUEST_CHANNEL, handler)
      }
    },
    reside: () => ipcRenderer.invoke(IpcChannel.lifecycleReside),
    requestQuit: () => ipcRenderer.invoke(IpcChannel.lifecycleRequestQuit),
    presentQuit: () => ipcRenderer.invoke(IpcChannel.lifecyclePresentQuit),
    cancelQuit: () => ipcRenderer.invoke(IpcChannel.lifecycleCancelQuit),
    completeQuit: () => ipcRenderer.invoke(IpcChannel.lifecycleCompleteQuit),
    loadWorkspace: () => ipcRenderer.invoke(IpcChannel.loadWorkspace),
    saveWorkspace: (input) => ipcRenderer.invoke(IpcChannel.saveWorkspace, input),
    listLaunchNotices: () => ipcRenderer.invoke(IpcChannel.listLaunchNotices),
    dismissLaunchNotices: (input) => ipcRenderer.invoke(IpcChannel.dismissLaunchNotices, input),
    listUnstoredResults: () => ipcRenderer.invoke(IpcChannel.listUnstoredResults),
    retryUnstoredResults: () => ipcRenderer.invoke(IpcChannel.retryUnstoredResults)
  },
  app: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.getStatus)
  }
}

contextBridge.exposeInMainWorld('xidao', api)
