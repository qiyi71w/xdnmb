import { Parser } from 'htmlparser2'
import type { AccountCookie, AccountFailure } from '../../shared/account'
import { parseExportPayload } from '../identity/parse'

export const ACCOUNT_ORIGIN = 'https://www.nmbxd1.com'
export class AccountError extends Error {
  override readonly name = 'AccountError'
  constructor(readonly reason: AccountFailure) { super(`account ${reason}`) }
}
const INDEX = /^\/Member\/User\/Cookie\/index(?:\.html|\/[A-Za-z0-9_./-]*)?$/
const EXPORT = /^\/Member\/User\/Cookie\/export\/id\/([1-9]\d{0,19})\.html$/
function official(url: URL): boolean {
  if (url.origin !== ACCOUNT_ORIGIN || url.username || url.password || /%|\\/.test(url.pathname)) return false
  // ThinkPHP query routing must not turn an allowed path into a different account action.
  if (/(?:^|\/)(?:switchTo|delete|apply|logout|qrcode)(?:\/|\.|$)/i.test(url.pathname)) return false
  for (const [key, value] of url.searchParams) {
    if (!/^[A-Za-z0-9_.-]*$/.test(key) || !/^[A-Za-z0-9_.-]*$/.test(value) ||
        /switchTo|delete|apply|logout|qrcode/i.test(key + value)) return false
  }
  return true
}
export function isAllowedAccountRead(url: URL): boolean {
  return official(url) && (INDEX.test(url.pathname) || (EXPORT.test(url.pathname) && !url.search))
}
/** Deny-by-default, shared by webRequest and all navigation gates. No arbitrary account page. */
export function isAllowedLoginRequest(raw: string, method: string, resourceType: string): boolean {
  let url: URL
  try { url = new URL(raw) } catch { return false }
  if (!official(url)) return false
  const path = url.pathname
  if (path === '/Member/User/Index/login.html') return method === 'GET' || method === 'POST'
  if (method !== 'GET') return false
  if (path === '/Member/User/Index/verify.html') return resourceType === 'image'
  // Only local static assets; account HTML, scripts that fetch writes, and external QR are excluded.
  return ['stylesheet', 'script', 'image', 'font'].includes(resourceType) &&
    /^\/(?:Public|public|static|assets)\/[A-Za-z0-9_./-]+\.(?:css|js|png|jpe?g|gif|webp|svg|woff2?|ttf|ico)$/i.test(path)
}
interface Element { tag: string; attrs: Record<string, string>; children: Element[]; text: string }
function document(html: string): Element {
  const root: Element = { tag: '', attrs: {}, children: [], text: '' }
  const stack = [root]
  const parser = new Parser({
    onopentag(tag, attrs) {
      const node: Element = { tag, attrs, children: [], text: '' }
      stack[stack.length - 1]!.children.push(node)
      stack.push(node)
    },
    ontext(text) { stack[stack.length - 1]!.text += text },
    onclosetag() { if (stack.length > 1) stack.pop() }
  }, { decodeEntities: true })
  parser.end(html)
  const all = descendants(root)
  if (all.some((node) => node.tag === 'title' && text(node).includes('跳转提示')) ||
      all.some((node) => node.tag === 'input' && node.attrs.type?.toLowerCase() === 'password') ||
      all.some((node) => node.tag === 'form' && node.attrs.action?.includes('/Index/login'))) {
    throw new AccountError('expired')
  }
  return root
}
function descendants(node: Element): Element[] { return node.children.flatMap((child) => [child, ...descendants(child)]) }
function text(node: Element): string { return (node.text + node.children.map(text).join('')).trim().replace(/\s+/g, ' ') }
function link(raw: string | undefined, base: URL): URL | null {
  if (raw === undefined) return null
  try { const url = new URL(raw, base); url.hash = ''; return url } catch { return null }
}
export function parseAccountList(html: string, pageUrl: URL): { cookies: AccountCookie[]; pages: URL[] } {
  const nodes = descendants(document(html))
  const table = nodes.find((node) => node.tag === 'table' && descendants(node).some((row) =>
    row.tag === 'tr' && row.children.filter((cell) => cell.tag === 'th' || cell.tag === 'td').map(text).join('|') === 'ID|饼干|有效时间|领取时间|操作'))
  if (!table) throw new AccountError('unknown-structure')
  const cookies: AccountCookie[] = []
  for (const row of descendants(table).filter((node) => node.tag === 'tr')) {
    const cells = row.children.filter((node) => node.tag === 'td' || node.tag === 'th')
    if (cells.map(text).join('|') === 'ID|饼干|有效时间|领取时间|操作') continue
    if (!cells.length) continue
    if (cells.length !== 5) throw new AccountError('unknown-structure')
    const id = text(cells[0]!)
    const exports = descendants(cells[4]!).filter((node) => node.tag === 'a').map((node) => link(node.attrs.href, pageUrl))
      .filter((url): url is URL => url !== null && official(url) && EXPORT.test(url.pathname) && !url.search)
    if (!/^[1-9]\d{0,19}$/.test(id) || exports.length !== 1 || EXPORT.exec(exports[0]!.pathname)?.[1] !== id ||
        cells.slice(1, 4).some((cell) => !text(cell))) throw new AccountError('unknown-structure')
    if (cookies.some((cookie) => cookie.id === id)) throw new AccountError('unknown-structure')
    cookies.push({ id, publicId: text(cells[1]!), validUntil: text(cells[2]!), claimedAt: text(cells[3]!) })
  }
  const pages = new Map<string, URL>()
  for (const node of nodes) {
    if (node.tag !== 'a') continue
    const url = link(node.attrs.href, pageUrl)
    if (url && official(url) && INDEX.test(url.pathname)) pages.set(url.href, url)
  }
  return { cookies, pages: [...pages.values()] }
}
export function parseAccountExport(html: string): string {
  const payloads: string[] = []
  for (const node of descendants(document(html))) {
    if (node.tag !== 'img' || !node.attrs.src) continue
    const url = link(node.attrs.src, new URL(ACCOUNT_ORIGIN))
    if (url?.hostname !== 'publicapi.ovear.info' || url.pathname !== '/qrcode.php' || !['http:', 'https:'].includes(url.protocol)) continue
    const payload = url.searchParams.get('text')
    if (payload !== null && parseExportPayload(payload).ok) payloads.push(payload)
  }
  if (payloads.length !== 1) throw new AccountError('unknown-structure')
  return payloads[0]!
}
