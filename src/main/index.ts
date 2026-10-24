import { app, BrowserWindow, Menu, session, type IpcMainInvokeEvent, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppPlatform } from '../shared/api'
import { createForumClient } from './forum/client'
import { createForumTransport } from './forum/transport'
import { registerIpc } from './ipc'
import { createReadingService } from './reading/service'
import { createRequestScheduler } from './reading/scheduler'
import { createSearchService, SEARCH_API_ORIGIN } from './search/service'
import type { ReadingStore } from './storage/contract'
import { openReadingStore } from './storage/store'
import createStorageWorker from './storage/worker?nodeWorker'

/** The only forum origin this ticket reads from (verified public JSON API). */
const FORUM_API_ORIGIN = 'https://api.nmb.best'

const rendererDevUrl = process.env.ELECTRON_RENDERER_URL
const rendererFile = join(import.meta.dirname, '../renderer/index.html')
const rendererFileUrl = pathToFileURL(rendererFile).href

function isAppDocument(url: string): boolean {
  if (rendererDevUrl) return URL.canParse(url) && new URL(url).origin === new URL(rendererDevUrl).origin
  return url.split(/[?#]/)[0] === rendererFileUrl
}

let mainWindow: BrowserWindow | null = null
let store: ReadingStore | null = null
let storeClosed = false

// Every renderer runs sandboxed; one main process owns the database worker.
app.enableSandbox()
if (!app.requestSingleInstanceLock()) app.quit()

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

  const reading = createReadingService({
    client: createForumClient({ transport: createForumTransport({ allowedOrigins: [FORUM_API_ORIGIN] }), baseUrl: FORUM_API_ORIGIN }),
    store: openedStore,
    scheduler: createRequestScheduler()
  })

  // Online search has its own credential-free transport that can reach only the search service.
  const search = createSearchService({
    transport: createForumTransport({
      allowedOrigins: [SEARCH_API_ORIGIN],
      maxCompressedBytes: 2 * 1024 * 1024,
      maxDecodedBytes: 4 * 1024 * 1024
    })
  })

  installMenu()
  const ipc = registerIpc({
    reading,
    search,
    store: openedStore,
    getStatus: () => ({ storage: openedStore.status, platform }),
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
