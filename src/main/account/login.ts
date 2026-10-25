import { BrowserWindow, session } from 'electron'
import { randomUUID } from 'node:crypto'
import { ACCOUNT_ORIGIN, AccountError, isAllowedLoginRequest } from './protocol'

const loginContents = new WeakSet<Electron.WebContents>()
/** The global app-document guard delegates only this registered remote window's login path. */
export function isAccountLoginNavigation(contents: Electron.WebContents, url: string): boolean {
  return loginContents.has(contents) && isAllowedLoginRequest(url, 'GET', 'mainFrame')
}

export interface AccountLoginSession { secret: string; expiresAt: string }
/** The only password-bearing content lives in Chromium's isolated, non-persistent session. */
export async function openAccountLogin(signal: AbortSignal): Promise<AccountLoginSession> {
  if (signal.aborted) throw new AccountError('cancelled')
  const isolated = session.fromPartition(`account-login-${randomUUID()}`, { cache: false })
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  isolated.setPermissionCheckHandler(() => false)
  isolated.on('will-download', (event) => event.preventDefault())
  isolated.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: !isAllowedLoginRequest(details.url, details.method, details.resourceType) })
  })
  const window = new BrowserWindow({
    title: '登录官网', width: 860, height: 720, autoHideMenuBar: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, devTools: false, spellcheck: false }
  })
  window.removeMenu()
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  loginContents.add(window.webContents)
  window.webContents.on('will-navigate', (event, url) => {
    if (!isAllowedLoginRequest(url, 'GET', 'mainFrame')) event.preventDefault()
  })
  window.webContents.on('will-redirect', (event, url) => {
    if (!isAllowedLoginRequest(url, 'GET', 'mainFrame')) event.preventDefault()
  })
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())
  const { promise, resolve, reject } = Promise.withResolvers<AccountLoginSession>()
  let settled = false
  const finish = (value: AccountLoginSession | null, reason: 'cancelled' | 'network' = 'cancelled') => {
    if (settled) return
    settled = true
    signal.removeEventListener('abort', abort)
    isolated.cookies.removeListener('changed', changed)
    if (!window.isDestroyed()) window.destroy()
    // Nothing from the remote window, including PHPSESSID and form data, remains on disk.
    void isolated.clearStorageData().catch(() => undefined)
    if (value) resolve(value)
    else reject(new AccountError(reason))
  }
  const abort = () => finish(null)
  const changed = (_event: Electron.Event, cookie: Electron.Cookie, _cause: string, removed: boolean) => {
    if (removed || cookie.name !== 'memberUserspapapa' || !['www.nmbxd1.com', '.nmbxd1.com', 'nmbxd1.com', '.www.nmbxd1.com'].includes(cookie.domain ?? '')) return
    const expires = (cookie.expirationDate ?? 0) * 1000
    if (expires <= Date.now() || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/.test(cookie.value)) return
    finish({ secret: cookie.value, expiresAt: new Date(expires).toISOString() })
  }
  isolated.cookies.on('changed', changed)
  window.on('closed', () => finish(null))
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  else void window.loadURL(`${ACCOUNT_ORIGIN}/Member/User/Index/login.html`).catch(() => finish(null, 'network'))
  return promise
}
