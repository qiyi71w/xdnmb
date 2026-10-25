import { request as httpsRequest } from 'node:https'
import type { ClientRequest } from 'node:http'
import type { RequestScheduler } from '../reading/scheduler'
import { ACCOUNT_ORIGIN, AccountError, isAllowedAccountRead, parseAccountExport, parseAccountList } from './protocol'
import type { AccountCookie } from '../../shared/account'

/** Raw HTTPS, no browser jar, automatic redirects, subresources, or QR fetches. */
export function requestAccountPage(url: URL, secret: string, signal: AbortSignal): Promise<string> {
  if (!isAllowedAccountRead(url) || !/^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]{1,4096}$/.test(secret)) {
    return Promise.reject(new AccountError('blocked'))
  }
  if (signal.aborted) return Promise.reject(new AccountError('cancelled'))
  const { promise, resolve, reject } = Promise.withResolvers<string>()
  let settled = false
  let request: ClientRequest | undefined
  const finish = (error: AccountError | null, text = '') => {
    if (settled) return
    settled = true
    clearTimeout(deadline)
    signal.removeEventListener('abort', abort)
    if (error) { request?.destroy(); reject(error) } else resolve(text)
  }
  const abort = () => finish(new AccountError('cancelled'))
  const deadline = setTimeout(() => finish(new AccountError('network')), 20_000)
  signal.addEventListener('abort', abort, { once: true })
  try {
    request = httpsRequest(url, {
      method: 'GET', headers: { Accept: 'text/html', 'Accept-Encoding': 'identity', 'User-Agent': 'Xidao/0.1', Cookie: `memberUserspapapa=${secret}` }
    }, (response) => {
      if (settled) { response.destroy(); return }
      const status = response.statusCode ?? 0
      if (status !== 200) {
        response.destroy()
        let loginRedirect = false
        if (status >= 300 && status < 400 && response.headers.location) {
          try {
            const target = new URL(response.headers.location, url)
            loginRedirect = target.origin === ACCOUNT_ORIGIN && target.pathname === '/Member/User/Index/login.html'
          } catch { /* Never follow or log an untrusted Location. */ }
        }
        finish(new AccountError(status === 429 ? 'rate-limited' : status === 401 || status === 403 || loginRedirect ? 'expired' : status >= 300 && status < 400 ? 'unknown-structure' : 'network'))
        return
      }
      const encoding = response.headers['content-encoding']
      if (encoding && encoding !== 'identity') { response.destroy(); finish(new AccountError('unknown-structure')); return }
      let size = 0
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) { response.destroy(); finish(new AccountError('unknown-structure')) }
        else chunks.push(chunk)
      })
      response.on('error', () => finish(new AccountError('network')))
      response.on('aborted', () => finish(new AccountError('network')))
      response.on('end', () => {
        try { finish(null, new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) }
        catch { finish(new AccountError('unknown-structure')) }
      })
    })
    request.on('error', () => finish(new AccountError('network')))
    if (signal.aborted) abort()
    else request.end()
  } catch { finish(new AccountError('network')) }
  return promise
}
export interface AccountClient {
  list(secret: string, signal: AbortSignal): Promise<AccountCookie[]>
  exportCookie(id: string, secret: string, signal: AbortSignal): Promise<string>
}
export function createAccountClient(deps: {
  request: (url: URL, secret: string, signal: AbortSignal) => Promise<string>
  scheduler: RequestScheduler
}): AccountClient {
  const read = (url: URL, secret: string, signal: AbortSignal) => {
    if (!isAllowedAccountRead(url)) return Promise.reject(new AccountError('blocked'))
    return deps.scheduler.run('foreground', signal, (active) => deps.request(url, secret, active))
  }
  return {
    async list(secret: string, signal: AbortSignal): Promise<AccountCookie[]> {
      const pending = [new URL('/Member/User/Cookie/index.html', ACCOUNT_ORIGIN)]
      const visited = new Set<string>()
      const cookies = new Map<string, AccountCookie>()
      while (pending.length) {
        const url = pending.shift()!
        if (visited.has(url.href)) continue
        if (visited.size >= 20) throw new AccountError('unknown-structure')
        visited.add(url.href)
        const page = parseAccountList(await read(url, secret, signal), url)
        for (const cookie of page.cookies) cookies.set(cookie.id, cookie)
        for (const next of page.pages) if (!visited.has(next.href)) pending.push(next)
      }
      return [...cookies.values()]
    },
    async exportCookie(id: string, secret: string, signal: AbortSignal): Promise<string> {
      if (!/^[1-9]\d{0,19}$/.test(id)) throw new AccountError('blocked')
      const url = new URL(`/Member/User/Cookie/export/id/${id}.html`, ACCOUNT_ORIGIN)
      return parseAccountExport(await read(url, secret, signal))
    }
  }
}
