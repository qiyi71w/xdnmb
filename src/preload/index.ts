import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { IpcChannel, LIFECYCLE_REQUEST_CHANNEL, type XidaoApi } from '../shared/api'
import type { LifecycleRequest } from '../shared/lifecycle'
import { REMINDERS_CHANGED_CHANNEL, REMINDERS_OPEN_CHANNEL } from '../shared/reminders'
import { OFFLINE_CHANGED_CHANNEL } from '../shared/content'
import { PUBLICATION_CHANGED_CHANNEL, PUBLICATION_FAILURE_CHANNEL, PUBLICATION_OPEN_DRAFT_CHANNEL, type SendFailureNotice } from '../shared/publication'
import type { ThreadId } from '../shared/forum'
import { UPDATE_STATE_CHANNEL, type UpdateState } from '../shared/updates'

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

/**
 * Main → renderer messages that must not be lost to a window React has not mounted yet: kept here,
 * in arrival order, until a subscriber takes them. Each message is the channel's argument list.
 */
function bufferedChannel<Args extends unknown[]>(channel: string) {
  const pending: Args[] = []
  const listeners = new Set<(...args: Args) => void>()
  ipcRenderer.on(channel, (_event: IpcRendererEvent, ...args: unknown[]) => {
    if (listeners.size === 0) pending.push(args as Args)
    else for (const listener of listeners) listener(...(args as Args))
  })
  return (listener: (...args: Args) => void) => {
    listeners.add(listener)
    if (pending.length > 0) queueMicrotask(() => {
      if (!listeners.has(listener)) return
      for (const args of pending.splice(0)) listener(...args)
    })
    return () => { listeners.delete(listener) }
  }
}
const onFailureNotice = bufferedChannel<[notice: SendFailureNotice, missed: boolean]>(PUBLICATION_FAILURE_CHANNEL)
const onOpenDraft = bufferedChannel<[notice: SendFailureNotice]>(PUBLICATION_OPEN_DRAFT_CHANNEL)

// Named operations only: no generic invoke/send, no Electron objects, URLs, SQL or file access.
const api: XidaoApi = {
  analytics: {
    getState: () => ipcRenderer.invoke(IpcChannel.analyticsGetState),
    setChoice: (choice) => ipcRenderer.invoke(IpcChannel.analyticsSetChoice, choice)
  },
  announcements: {
    getState: () => ipcRenderer.invoke(IpcChannel.announcementGetState),
    refresh: () => ipcRenderer.invoke(IpcChannel.announcementRefresh),
    takeAutomatic: () => ipcRenderer.invoke(IpcChannel.announcementTakeAutomatic),
    suppress: (identity) => ipcRenderer.invoke(IpcChannel.announcementSuppress, identity)
  },
  blocks: {
    list: () => ipcRenderer.invoke(IpcChannel.listBlocks),
    set: (input) => ipcRenderer.invoke(IpcChannel.setBlock, input)
  },
  cookieColors: {
    list: () => ipcRenderer.invoke(IpcChannel.listCookieColors),
    add: (input) => ipcRenderer.invoke(IpcChannel.addCookieColor, input),
    set: (input) => ipcRenderer.invoke(IpcChannel.setCookieColor, input),
    remove: (input) => ipcRenderer.invoke(IpcChannel.removeCookieColor, input)
  },
  reminders: {
    getRules: (input) => ipcRenderer.invoke(IpcChannel.reminderGetRules, input),
    setRule: (input) => ipcRenderer.invoke(IpcChannel.reminderSetRule, input),
    overview: () => ipcRenderer.invoke(IpcChannel.reminderOverview),
    check: () => ipcRenderer.invoke(IpcChannel.reminderCheck),
    cancel: () => ipcRenderer.invoke(IpcChannel.reminderCancel),
    closeForThreads: (input) => ipcRenderer.invoke(IpcChannel.reminderCloseForThreads, input),
    clear: (input) => ipcRenderer.invoke(IpcChannel.reminderClear, input),
    dismissRateLimit: (input) => ipcRenderer.invoke(IpcChannel.reminderDismissRateLimit, input),
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
    listHistory: () => ipcRenderer.invoke(IpcChannel.listHistory),
    listOffline: () => ipcRenderer.invoke(IpcChannel.listOffline),
    clearHistory: (input) => ipcRenderer.invoke(IpcChannel.clearHistory, input),
    usage: () => ipcRenderer.invoke(IpcChannel.contentUsage),
    setCacheLimit: (input) => ipcRenderer.invoke(IpcChannel.setCacheLimit, input),
    clearCache: () => ipcRenderer.invoke(IpcChannel.clearCache),
    saveOffline: (input) => ipcRenderer.invoke(IpcChannel.saveOffline, input),
    offlineStatus: (input) => ipcRenderer.invoke(IpcChannel.offlineStatus, input),
    cancelOffline: (input) => ipcRenderer.invoke(IpcChannel.cancelOffline, input),
    deleteOffline: (input) => ipcRenderer.invoke(IpcChannel.deleteOffline, input),
    onOfflineChanged(listener) {
      const receive = (_event: IpcRendererEvent, threadId: ThreadId) => listener(threadId)
      ipcRenderer.on(OFFLINE_CHANGED_CHANNEL, receive)
      return () => { ipcRenderer.removeListener(OFFLINE_CHANGED_CHANNEL, receive) }
    },
    holdReader: (input) => ipcRenderer.invoke(IpcChannel.holdContentReader, input),
    releaseReader: (input) => ipcRenderer.invoke(IpcChannel.releaseContentReader, input)
  },
  subscriptions: {
    getOverview: () => ipcRenderer.invoke(IpcChannel.subscriptionOverview),
    configureApp: (input) => ipcRenderer.invoke(IpcChannel.subscriptionConfigureApp, input),
    revealAppUuid: () => ipcRenderer.invoke(IpcChannel.subscriptionRevealApp),
    selectSource: (input) => ipcRenderer.invoke(IpcChannel.subscriptionSelectSource, input),
    getObservation: (input) => ipcRenderer.invoke(IpcChannel.subscriptionObservation, input),
    getSnapshot: (input) => ipcRenderer.invoke(IpcChannel.subscriptionSnapshot, input),
    read: (input) => ipcRenderer.invoke(IpcChannel.subscriptionRead, input),
    change: (input) => ipcRenderer.invoke(IpcChannel.subscriptionChange, input),
    getOperations: () => ipcRenderer.invoke(IpcChannel.subscriptionOperations),
    reconcile: (input) => ipcRenderer.invoke(IpcChannel.subscriptionReconcile, input),
    dismiss: (input) => ipcRenderer.invoke(IpcChannel.subscriptionDismiss, input),
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
    openSite: (input) => ipcRenderer.invoke(IpcChannel.openOnlineSearchSite, input),
    threadOf: (input) => ipcRenderer.invoke(IpcChannel.searchThreadOf, input)
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
  clipboard: {
    run: (input) => ipcRenderer.invoke(IpcChannel.clipboard, input)
  },
  links: {
    openExternal: (input) => ipcRenderer.invoke(IpcChannel.openExternal, input)
  },
  images: {
    load: (input) => ipcRenderer.invoke(IpcChannel.loadImage, input),
    cancel: (input) => ipcRenderer.invoke(IpcChannel.cancelImage, input),
    releaseView: (input) => ipcRenderer.invoke(IpcChannel.releaseImageView, input),
    saveOriginal: (input) => ipcRenderer.invoke(IpcChannel.saveOriginalImage, input),
    copyOriginal: (input) => ipcRenderer.invoke(IpcChannel.copyOriginalImage, input)
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
    setPoWarning: (input) => ipcRenderer.invoke(IpcChannel.setPoWarning, input),
    onFailureNotice,
    onOpenDraft,
    onChanged(listener) {
      const receive = () => listener()
      ipcRenderer.on(PUBLICATION_CHANGED_CHANNEL, receive)
      return () => { ipcRenderer.removeListener(PUBLICATION_CHANGED_CHANNEL, receive) }
    }
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
    completeQuit: (input) => ipcRenderer.invoke(IpcChannel.lifecycleCompleteQuit, input),
    loadWorkspace: () => ipcRenderer.invoke(IpcChannel.loadWorkspace),
    saveWorkspace: (input) => ipcRenderer.invoke(IpcChannel.saveWorkspace, input),
    listLaunchNotices: () => ipcRenderer.invoke(IpcChannel.listLaunchNotices),
    dismissLaunchNotices: (input) => ipcRenderer.invoke(IpcChannel.dismissLaunchNotices, input),
    listUnstoredResults: () => ipcRenderer.invoke(IpcChannel.listUnstoredResults),
    retryUnstoredResults: () => ipcRenderer.invoke(IpcChannel.retryUnstoredResults)
  },
  updates: {
    getState: () => ipcRenderer.invoke(IpcChannel.updateGetState),
    onState(listener) {
      const handler = (_event: IpcRendererEvent, state: UpdateState) => listener(state)
      ipcRenderer.on(UPDATE_STATE_CHANNEL, handler)
      return () => { ipcRenderer.removeListener(UPDATE_STATE_CHANNEL, handler) }
    },
    check: () => ipcRenderer.invoke(IpcChannel.updateCheck),
    download: () => ipcRenderer.invoke(IpcChannel.updateDownload),
    cancelDownload: () => ipcRenderer.invoke(IpcChannel.updateCancelDownload),
    installAndRestart: () => ipcRenderer.invoke(IpcChannel.updateInstallAndRestart),
    openInstaller: () => ipcRenderer.invoke(IpcChannel.updateOpenInstaller),
    acknowledgeNotice: (input) => ipcRenderer.invoke(IpcChannel.updateAcknowledgeNotice, input)
  },
  app: {
    getStatus: () => ipcRenderer.invoke(IpcChannel.getStatus)
  }
}

contextBridge.exposeInMainWorld('xidao', api)
