import { app, BrowserWindow, dialog, Menu, protocol, session, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { createReadStream } from 'node:fs'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import type { AppPlatform } from '../shared/api'
import { IMAGE_FORMAT_EXTENSION, IMAGE_SCHEME } from '../shared/images'
import { createForumClient } from './forum/client'
import { createForumTransport } from './forum/transport'
import { IMAGE_MEDIA_TYPE, openManagedImageFiles, type ManagedImageFiles } from './images/files'
import { createImageService } from './images/service'
import { createImageDownloader } from './images/transport'
import { createSafeStorageProtector } from './identity/protection'
import { createIdentityService } from './identity/service'
import { registerIpc } from './ipc'
import { createReadingService } from './reading/service'
import { createRequestScheduler } from './reading/scheduler'
import type { AppStore } from './storage/contract'
import { openReadingStore } from './storage/store'
import createStorageWorker from './storage/worker?nodeWorker'
import { createSubscriptionService } from './subscriptions/service'

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

// Every renderer runs sandboxed; one main process owns the database worker.
app.enableSandbox()
if (!app.requestSingleInstanceLock()) app.quit()
// Managed image files are shown through the app's own scheme, never by file path or remote URL.
protocol.registerSchemesAsPrivileged([{ scheme: IMAGE_SCHEME, privileges: { standard: true, secure: true } }])

app.on('second-instance', () => {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.focus()
})

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
 * Edit roles keep native copy/paste (required on macOS); zoom roles keep interface zoom.
 */
function installMenu(): void {
  const view: MenuItemConstructorOptions[] = [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }]
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
  window.once('ready-to-show', () => window.show())
  if (rendererDevUrl) void window.loadURL(rendererDevUrl)
  else void window.loadFile(rendererFile)
  return window
}

/** Serves `xidao-image://file/<managed name>` from the image directory; anything else is 404. */
function serveManagedImages(files: ManagedImageFiles): void {
  const notFound = () => new Response(null, { status: 404 })
  protocol.handle(IMAGE_SCHEME, async (request) => {
    const url = new URL(request.url)
    const name = url.hostname === 'file' ? url.pathname.slice(1) : ''
    const path = files.pathOf(name)
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

  const reading = createReadingService({
    client: createForumClient({
      transport: createForumTransport({ allowedOrigins: [FORUM_API_ORIGIN], credentialOrigins: [FORUM_API_ORIGIN] }),
      baseUrl: FORUM_API_ORIGIN,
      browseIdentity: () => identities.browseUserhash()
    }),
    store: openedStore,
    scheduler
  })

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
  serveManagedImages(imageFiles)

  installMenu()
  const ipc = registerIpc({
    reading,
    images,
    identities,
    subscriptions,
    store: openedStore,
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
    isTrustedSender: (event: IpcMainInvokeEvent) =>
      mainWindow !== null &&
      event.sender === mainWindow.webContents &&
      event.senderFrame !== null &&
      event.senderFrame.parent === null &&
      isAppDocument(event.senderFrame.url)
  })

  mainWindow = createWindow()
  const contents = mainWindow.webContents
  // Reads started by a page that navigated away or closed are cancelled, not left running.
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) ipc.cancelAllFor(contents)
  })
  mainWindow.on('closed', () => {
    ipc.cancelAllFor(contents)
    mainWindow = null
  })
}

app.whenReady().then(start, (error: unknown) => {
  console.error('[app] startup failed', error instanceof Error ? error.name : typeof error)
  app.quit()
})

app.on('window-all-closed', () => app.quit())

app.on('will-quit', (event) => {
  if (!store || storeClosed) return
  event.preventDefault()
  storeClosed = true
  void store.close().finally(() => app.quit())
})
