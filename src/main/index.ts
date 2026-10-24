import {
  app, BrowserWindow, dialog, Menu, nativeImage, nativeTheme, Notification, protocol, session, Tray,
  type IpcMainInvokeEvent, type MenuItemConstructorOptions
} from 'electron'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { LIFECYCLE_REQUEST_CHANNEL, type AppPlatform } from '../shared/api'
import { IMAGE_FORMAT_EXTENSION, IMAGE_SCHEME } from '../shared/images'
import { createContentService, type ContentService } from './content/service'
import { createDraftService } from './drafts/service'
import type { ZoomAction } from '../shared/settings'
import { createSettingsService } from './appearance'
import { createForumClient } from './forum/client'
import { createForumTransport } from './forum/transport'
import { IMAGE_MEDIA_TYPE, openManagedImageFiles, type ManagedImageFiles } from './images/files'
import { createImageService } from './images/service'
import { createImageDownloader } from './images/transport'
import { createSafeStorageProtector } from './identity/protection'
import { createIdentityService } from './identity/service'
import { registerIpc, type IpcRegistration } from './ipc'
import { createLifecycle, type FinishingSummary, type Lifecycle, type MainWindowHost } from './lifecycle/controller'
import { createReadingService } from './reading/service'
import { createRequestScheduler } from './reading/scheduler'
import type { AppStore } from './storage/contract'
import { openReadingStore } from './storage/store'
import createStorageWorker from './storage/worker?nodeWorker'
import { createSubscriptionService } from './subscriptions/service'
import { createPublicationAdapter } from './publication/adapter'
import { createPublicationService } from './publication/service'
import trayIconPath from '../../resources/tray-icon.png?asset'
import { REMINDERS_OPEN_CHANNEL } from '../shared/reminders'
import { createReminderService } from './reminders/service'
import { createReminderNotifier } from './reminders/notifier'
import { applyZoom, zoomActionOf } from './zoom'

/** Verified JSON API origin; the only destination for the selected browse credential. */
const FORUM_API_ORIGIN = 'https://api.nmb.best'
/** Web subscriptions use their fixed identity, never the browse credential. */
const FORUM_WEB_ORIGIN = 'https://www.nmbxd1.com'
/** Image server announced by `getCDNPath` (both entries); thumbnails under `thumb/`, originals under `image/`. */
const IMAGE_ORIGIN = 'https://image.nmb.best'

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const rendererFile = join(import.meta.dirname, '../renderer/index.html')
const rendererFileUrl = pathToFileURL(rendererFile).href

function isAppDocument(url: string): boolean {
  if (rendererDevUrl) return URL.canParse(url) && new URL(url).origin === new URL(rendererDevUrl).origin
  return url.split(/[?#]/)[0] === rendererFileUrl
}

let mainWindow: BrowserWindow | null = null
let store: AppStore | null = null
let storeClosed = false
let content: ContentService | null = null
let lifecycle: Lifecycle | null = null
/** Kept referenced for the app's lifetime (Windows/Linux). */
let tray: Tray | null = null

// Every renderer runs sandboxed; one main process owns the database worker.
app.enableSandbox()
if (!app.requestSingleInstanceLock()) app.quit()
// Managed image files are shown through the app's own scheme, never by file path or remote URL.
protocol.registerSchemesAsPrivileged([{ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true } }])

// A second launch never opens a second writer: it is an explicit reopen of this process.
app.on('second-instance', () => lifecycle?.reopen())
// macOS Dock. Also fires during launch; the lifecycle ignores it until the first window is shown.
app.on('activate', () => lifecycle?.reopen())

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-attach-webview', (event) => event.preventDefault())
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, url) => {
    if (!isAppDocument(url)) event.preventDefault()
  })
  contents.on('will-redirect', (event, url) => {
    if (!isAppDocument(url)) event.preventDefault()
  })
})

const platform: AppPlatform = process.platform === 'darwin' || process.platform === 'win32' ? process.platform : 'linux'

/**
 * Application menu without the default Reload / Force Reload / Close Window accelerators:
 * Ctrl/Cmd+R refreshes the current content and Ctrl/Cmd+W closes the current tab inside the app.
 * Edit roles keep native copy/paste (required on macOS). Zoom keys are handled in `before-input-event`
 * (so `=`, `+` and the numpad all work); the menu only shows them.
 */
function installMenu(): void {
  const zoomItem = (label: string, accelerator: string, action: ZoomAction): MenuItemConstructorOptions => ({
    label,
    accelerator,
    registerAccelerator: false,
    click: () => {
      if (mainWindow) applyZoom(mainWindow.webContents, action)
    }
  })
  const view: MenuItemConstructorOptions[] = [
    zoomItem('实际大小', 'CommandOrControl+0', 'reset'),
    zoomItem('放大', 'CommandOrControl+=', 'in'),
    zoomItem('缩小', 'CommandOrControl+-', 'out')
  ]
  if (rendererDevUrl) view.push({ type: 'separator' }, { role: 'toggleDevTools' })
  const template: MenuItemConstructorOptions[] = [
    ...(platform === 'darwin' ? [{ role: 'appMenu' } satisfies MenuItemConstructorOptions] : []),
    { role: 'editMenu' },
    { label: '视图', submenu: view },
    ...(platform === 'darwin' ? [{ role: 'windowMenu' } satisfies MenuItemConstructorOptions] : [])
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    // Narrow windows fall back to compact navigation, an overlay and a single pane.
    minWidth: 480,
    minHeight: 480,
    show: false,
    title: '汐岛',
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.cjs'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false
    }
  })
  // Windows/Linux keep the menu's accelerators but show no menu bar.
  if (platform !== 'darwin') window.setMenuBarVisibility(false)
  // Lifecycle owns close; zoom only consumes its own input events.
  window.on('close', (event) => {
    if (lifecycle === null || lifecycle.phase === 'exiting') return
    event.preventDefault()
    void lifecycle.closeRequested()
  })
  window.webContents.on('before-input-event', (event, input) => {
    const action = zoomActionOf(input, platform)
    if (action === null) return
    event.preventDefault()
    applyZoom(window.webContents, action)
  })
  if (rendererDevUrl) void window.loadURL(rendererDevUrl)
  else void window.loadFile(rendererFile)
  return window
}

/** 16 px tray icon with a 2× representation for high-DPI taskbars. */
function trayImage(): Electron.NativeImage {
  const source = nativeImage.createFromPath(trayIconPath)
  const image = nativeImage.createEmpty()
  if (source.isEmpty()) return image
  for (const scaleFactor of [1, 2]) {
    const size = 16 * scaleFactor
    image.addRepresentation({ scaleFactor, buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG() })
  }
  return image
}

/** Best effort: the launch notices are already stored, so an unavailable notification loses nothing. */
function notifyUnfinished({ failed, unknown }: FinishingSummary): void {
  if (!Notification.isSupported()) return
  const parts: string[] = []
  if (failed.length > 0) parts.push(`${failed.length} 个发送失败`)
  if (unknown.length > 0) parts.push(`${unknown.length} 个发送结果待确认`)
  const notification = new Notification({
    title: '汐岛退出时有发送没有完成',
    body: `${parts.join('，')}。下次打开汐岛会再次提示，不会自动重发。`
  })
  notification.on('click', () => lifecycle?.reopen())
  notification.show()
}

/**
 * Serves `xidao-image://file/<managed name>` (forum images) and `xidao-image://draft/<managed name>`
 * (draft attachment copies) from their directories; anything else is 404.
 */
function serveManagedImages(directories: Record<'file' | 'draft', ManagedImageFiles>): void {
  const notFound = () => new Response(null, { status: 404 })
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const url = new URL(request.url)
    const files = url.hostname === 'file' || url.hostname === 'draft' ? directories[url.hostname] : null
    const name = url.pathname.slice(1)
    const path = files === null ? null : files.pathOf(name)
    if (path === null) return notFound()
    try {
      const stat = await lstat(path)
      if (!stat.isFile()) return notFound()
      const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>
      return new Response(body, {
        headers: {
          'Content-Type': IMAGE_MEDIA_TYPE[name.slice(name.lastIndexOf('.') + 1)] ?? 'application/octet-stream',
          'Content-Length': String(stat.size),
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store'
        }
      })
    } catch {
      return notFound()
    }
  })
}

async function start(): Promise<void> {
  const denyAll = session.defaultSession
  denyAll.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  denyAll.setPermissionCheckHandler(() => false)

  const openedStore = await openReadingStore({
    databasePath: join(app.getPath('userData'), 'xidao.sqlite'),
    createWorker: createStorageWorker
  })
  store = openedStore
  if (openedStore.status.state !== 'ready') console.error('[storage] status', openedStore.status.state)
  const protector = createSafeStorageProtector()
  const scheduler = createRequestScheduler()

  const identities = createIdentityService({
    store: openedStore,
    protector,
    storageState: () => openedStore.status.state
  })

  const client = createForumClient({
    transport: createForumTransport({ allowedOrigins: [FORUM_API_ORIGIN], credentialOrigins: [FORUM_API_ORIGIN] }),
    baseUrl: FORUM_API_ORIGIN,
    browseIdentity: () => identities.browseUserhash()
  })
  const reading = createReadingService({ client, store: openedStore, scheduler })
  const reminders = createReminderService({
    store: openedStore, client, scheduler,
    async afterBatch() {
      try { await content?.enforceQuota() }
      catch { console.error('[content] cleanup failed') }
    },
    notifier: createReminderNotifier({
      isSupported: () => Notification.isSupported(),
      create: (message) => new Notification(message),
      async openList() {
        await lifecycle?.revealWithoutTrigger()
        mainWindow?.webContents.send(REMINDERS_OPEN_CHANNEL)
      }
    })
  })
  await reminders.recover().catch(() => console.error('[reminders] recovery failed'))

  const subscriptions = createSubscriptionService({
    store: openedStore,
    protector,
    scheduler,
    transport: createForumTransport({
      allowedOrigins: [FORUM_API_ORIGIN, FORUM_WEB_ORIGIN],
      credentialOrigins: [FORUM_WEB_ORIGIN]
    }),
    appOrigin: FORUM_API_ORIGIN,
    webOrigin: FORUM_WEB_ORIGIN
  })
  // Recovery records unresolved intentions; it never issues a forum request.
  await subscriptions.recover().catch(() => console.error('[subscriptions] recovery failed'))

  const imageFiles = await openManagedImageFiles(join(app.getPath('userData'), 'images'))
  const images = createImageService({
    store: openedStore,
    files: imageFiles,
    download: createImageDownloader({ allowedOrigins: [IMAGE_ORIGIN] }),
    origin: IMAGE_ORIGIN
  })
  // Before any view can load images: drop last run's reading holders and leftover files.
  await images.recover().catch(() => console.error('[images] recovery failed'))

  const draftFiles = await openManagedImageFiles(join(app.getPath('userData'), 'draft-images'))
  const drafts = createDraftService({ store: openedStore, files: draftFiles })
  const publication = createPublicationService({
    store: openedStore, drafts, files: draftFiles, protector: createSafeStorageProtector(),
    clientFor: (userhash) => createForumClient({
      transport: createForumTransport({ allowedOrigins: [FORUM_API_ORIGIN], credentialOrigins: [FORUM_API_ORIGIN] }),
      baseUrl: FORUM_API_ORIGIN, browseIdentity: async () => userhash
    }),
    adapter: createPublicationAdapter()
  })
  await publication.recover().catch(() => console.error('[publication] recovery failed'))
  // No editor exists yet: copies no saved draft references, and leftover files, are removed.
  await drafts.recover().catch(() => console.error('[drafts] recovery failed'))
  serveManagedImages({ file: imageFiles, draft: draftFiles })

  const retained = createContentService({
    store: openedStore, client, scheduler, images, files: imageFiles,
    databasePath: join(app.getPath('userData'), 'xidao.sqlite')
  })
  content = retained
  await retained.recover().catch(() => console.error('[content] recovery failed'))
  await retained.enforceQuota().catch(() => console.error('[content] cleanup failed'))

  installMenu()
  let ipc: IpcRegistration | null = null
  let backgroundStopped = Promise.resolve()

  /** Wires a new main window: its reads stop when it navigates away or closes. */
  const attach = (window: BrowserWindow) => {
    mainWindow = window
    const contents = window.webContents
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) ipc?.cancelAllFor(contents)
    })
    window.on('closed', () => {
      ipc?.cancelAllFor(contents)
      if (mainWindow === window) mainWindow = null
    })
  }
  const host: MainWindowHost = {
    state: () => (mainWindow === null ? 'none' : mainWindow.isVisible() ? 'shown' : 'hidden'),
    open: async () => {
      await backgroundStopped
      retained.resume()
      const { promise, resolve } = Promise.withResolvers<void>()
      const window = createWindow()
      attach(window)
      window.once('ready-to-show', () => {
        window.show()
        resolve()
      })
      await promise
    },
    reveal() {
      if (mainWindow === null) return
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    },
    hide: () => mainWindow?.hide(),
    destroy() {
      const window = mainWindow
      mainWindow = null
      // Not inside the IPC call that asked for it; its renderer is untrusted from now on.
      if (window !== null) setImmediate(() => window.destroy())
    },
    send: (request) => mainWindow?.webContents.send(LIFECYCLE_REQUEST_CHANNEL, request)
  }
  const controller = createLifecycle({
    window: host,
    closeAction: async () => (await openedStore.loadSettings()).closeAction,
    publication,
    stopBackgroundWork: async () => {
      ipc?.cancelAll()
      backgroundStopped = Promise.all([retained.stop(), reminders.stop('quit')]).then(() => undefined)
      await backgroundStopped
    },
    notify: notifyUnfinished,
    exit: () => app.quit(),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    onTrigger: (trigger) => { void reminders.request(trigger) }
  })
  lifecycle = controller

  ipc = registerIpc({
    reading,
    images,
    identities,
    drafts,
    content: retained,
    subscriptions,
    publication,
    reminders,
    lifecycle: controller,
    store: openedStore,
    settings: createSettingsService(openedStore),
    getStatus: () => ({ storage: openedStore.status, platform }),
    async chooseSavePath(sender, suggestedName, format) {
      const window = BrowserWindow.fromWebContents(sender)
      const extension = IMAGE_FORMAT_EXTENSION[format]
      const options: Electron.SaveDialogOptions = {
        title: '保存原图',
        defaultPath: join(app.getPath('downloads'), suggestedName),
        filters: [{ name: `${format.toUpperCase()} 图片`, extensions: [extension] }],
        properties: ['createDirectory', 'showOverwriteConfirmation']
      }
      const result = window === null ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(window, options)
      return result.canceled || !result.filePath ? null : result.filePath
    },
    async chooseImageFile(sender) {
      const window = BrowserWindow.fromWebContents(sender)
      const options: Electron.OpenDialogOptions = {
        title: '选择附图',
        filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'gif', 'webp'] }],
        properties: ['openFile']
      }
      const result = window === null ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(window, options)
      return result.canceled ? null : (result.filePaths[0] ?? null)
    },
    systemPrefersDark: () => nativeTheme.shouldUseDarkColors,
    isTrustedSender: (event: IpcMainInvokeEvent) =>
      mainWindow !== null &&
      event.sender === mainWindow.webContents &&
      event.senderFrame !== null &&
      event.senderFrame.parent === null &&
      isAppDocument(event.senderFrame.url)
  })

  // Windows tray / Linux status icon; macOS reopens from the Dock.
  if (platform !== 'darwin') {
    tray = new Tray(trayImage())
    tray.setToolTip('汐岛')
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: '打开汐岛', click: () => controller.reopen() },
      { type: 'separator' },
      { label: '退出汐岛', click: () => controller.requestQuit() }
    ]))
    tray.on('click', () => controller.reopen())
  }

  await controller.start()
}

app.whenReady().then(start, (error: unknown) => {
  console.error('[app] startup failed', error instanceof Error ? error.name : typeof error)
  app.quit()
})

// The lifecycle decides when the app ends: closing or hiding the window never quits by itself.
app.on('window-all-closed', () => undefined)

// App menu / Cmd+Q / tray all quit through the lifecycle (unsaved editors, started sends).
app.on('before-quit', (event) => {
  if (lifecycle === null || lifecycle.phase === 'starting' || lifecycle.phase === 'exiting') return
  event.preventDefault()
  lifecycle.requestQuit()
})

app.on('will-quit', (event) => {
  if (!store || storeClosed) return
  event.preventDefault()
  storeClosed = true
  void (async () => {
    await content?.stop()
    await store?.close()
  })().finally(() => app.quit())
})
