import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createAnnouncementService } from '../src/main/announcements/service'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import { createForumTransport } from '../src/main/forum/transport'
import type { ForumTransport } from '../src/main/forum/contract'
import { ANNOUNCEMENT_URL, MAX_ANNOUNCEMENT_LENGTH } from '../src/shared/announcements'
import { DEFAULT_SETTINGS } from '../src/shared/settings'
import { asStore } from './helpers/store'

const folders: string[] = []
const databases: ReadingDatabase[] = []
const servers: Server[] = []
const notice = { date: 'opaque/version-001', content: '<b>公告</b><br>&gt;&gt;No.12345', enable: true }
function open(path?: string) {
  if (!path) {
    const folder = mkdtempSync(join(tmpdir(), 'xidao-announcements-'))
    folders.push(folder)
    path = join(folder, 'reading.sqlite')
  }
  const db = openReadingDatabase(path)
  databases.push(db)
  return { db, path }
}
function source(value: unknown): ForumTransport {
  return { get: async () => ({ mediaType: 'application/json', text: JSON.stringify(value) }) }
}
function service(db: ReadingDatabase, transport = source(notice), isForeground = () => true) {
  return createAnnouncementService({ store: asStore(db), transport, isForeground })
}
afterEach(async () => {
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
  await Promise.all(servers.splice(0).map((server) => {
    const { promise, resolve } = Promise.withResolvers<void>()
    server.close(() => resolve())
    server.closeAllConnections()
    return promise
  }))
})

describe('startup announcements', () => {
  it('confirms only this run, persists suppression across reopen and ordinary cache/settings writes, and recognizes a same-date revision', async () => {
    const { db, path } = open()
    const first = service(db)
    expect(await first.takeAutomatic()).toMatchObject(notice)
    expect(await first.takeAutomatic()).toBeNull()
    const confirmedRestart = service(db)
    expect(await confirmedRestart.takeAutomatic()).toMatchObject(notice)
    expect(await confirmedRestart.suppress(notice)).toEqual({ saved: true })
    db.saveSettings({ ...DEFAULT_SETTINGS, newTabSplitDefault: false })
    db.evictContentBatch(true)
    db.close()
    databases.splice(databases.indexOf(db), 1)
    const reopened = open(path).db
    expect(await service(reopened).takeAutomatic()).toBeNull()
    expect(reopened.loadSettings().newTabSplitDefault).toBe(false)
    const revised = { ...notice, content: '修订后的正文' }
    expect(await service(reopened, source(revised)).takeAutomatic()).toMatchObject(revised)
    expect(await service(reopened, source({ ...notice, date: 'opaque/version-001/suffix' })).takeAutomatic()).toMatchObject({ date: 'opaque/version-001/suffix' })
  })

  it('waits for foreground, grants once under concurrent claims, and never restores the grant on explicit refresh', async () => {
    const { db } = open()
    let foreground = false
    let reads = 0
    const current = service(db, { get: async () => { reads++; return { mediaType: null, text: JSON.stringify(notice) } } }, () => foreground)
    await current.start()
    expect(await current.takeAutomatic()).toBeNull()
    foreground = true
    const claims = await Promise.all([current.takeAutomatic(), current.takeAutomatic()])
    expect(claims[0]).toMatchObject(notice)
    expect(claims[1]).toBeNull()
    await current.getState()
    await current.start()
    expect(reads).toBe(1)
    expect(await current.refresh()).toMatchObject({ source: 'current', outcome: 'ready' })
    expect(reads).toBe(2)
    expect(await current.takeAutomatic()).toBeNull()
  })

  it('retains the last successful content offline without automatic presentation and distinguishes malformed and disabled responses', async () => {
    const { db } = open()
    await service(db).start()
    const offline = service(db, { get: async () => { throw new Error('offline') } })
    expect(await offline.getState()).toMatchObject({ source: 'cached', outcome: 'network-error', latest: notice })
    expect(await offline.takeAutomatic()).toBeNull()
    const invalid = service(db, source({ ...notice, enable: 'true' }))
    expect(await invalid.getState()).toMatchObject({ outcome: 'invalid', latest: notice, source: 'cached' })
    expect(await invalid.takeAutomatic()).toBeNull()
    const disabled = service(db, source({ date: 2026102100008, content: '', enable: false }))
    expect(await disabled.getState()).toMatchObject({ outcome: 'disabled', latest: notice })
    expect(await disabled.takeAutomatic()).toBeNull()
  })

  it('does not claim suppression saved when a real read-only SQLite database refuses writes', async () => {
    const { db, path } = open()
    await service(db).start()
    db.close()
    databases.splice(databases.indexOf(db), 1)
    // The supported newer-schema mode opens the real database read-only.
    const raw = new Database(path)
    raw.pragma('user_version = 999')
    raw.close()
    const readonly = open(path).db
    expect(readonly.status.state).toBe('read-only')
    const current = service(readonly)
    expect(await current.getState()).toMatchObject({ outcome: 'ready', saved: false })
    expect(await current.suppress(notice)).toEqual({ saved: false })
    expect(await service(readonly).takeAutomatic()).toMatchObject(notice)
  })

  it('serializes a suppression choice with a late refresh so neither write loses the other', async () => {
    const { db } = open()
    const response = Promise.withResolvers<{ mediaType: null; text: string }>()
    let reads = 0
    const current = service(db, { get: async () => ++reads === 1 ? { mediaType: null, text: JSON.stringify(notice) } : response.promise })
    await current.start()
    const refresh = current.refresh()
    expect(await current.suppress(notice)).toEqual({ saved: true })
    response.resolve({ mediaType: null, text: JSON.stringify({ ...notice, content: 'revision' }) })
    await refresh
    expect(db.loadAnnouncements()).toMatchObject({ suppressed: { date: notice.date, content: notice.content }, latest: { content: 'revision' } })
  })

  it('only exposes safe visible content and rejects bodies with no visible text', async () => {
    const { db } = open()
    const content = '<script>window.pwned=1</script><img src="https://evil.invalid/pixel"><b>安全</b><a href="javascript:alert(1)">文字</a><br>&gt;&gt;No.12345'
    const state = await service(db, source({ ...notice, content })).getState()
    expect(state.latest?.nodes).toEqual([
      { type: 'emphasis', style: 'bold', children: [{ type: 'text', text: '安全' }] },
      { type: 'text', text: '文字' }, { type: 'lineBreak' }, { type: 'quoteRef', postId: '12345', raw: '>>No.12345' }
    ])
    expect(await service(db, source({ ...notice, content: '<img src="https://evil.invalid/pixel">' })).getState()).toMatchObject({ outcome: 'invalid' })
  })

  it('uses credential-free bounded HTTP, shares concurrent refreshes, and refuses redirects without contacting the target', async () => {
    const { db } = open()
    const headers: IncomingHttpHeaders[] = []
    let mode: 'ok' | 'redirect' | 'large' = 'ok'
    let target = false
    const server = createServer((request, response) => {
      headers.push(request.headers)
      if (request.url === '/target') target = true
      if (mode === 'redirect') { response.writeHead(302, { Location: '/target' }); response.end(); return }
      response.end(mode === 'large' ? 'x'.repeat(MAX_ANNOUNCEMENT_LENGTH + 1) : JSON.stringify(notice))
    })
    servers.push(server)
    const listening = Promise.withResolvers<void>()
    server.listen(0, '127.0.0.1', listening.resolve)
    await listening.promise
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No server address')
    const origin = `http://127.0.0.1:${address.port}`
    const bounded = createForumTransport({ allowedOrigins: [origin], maxDecodedBytes: MAX_ANNOUNCEMENT_LENGTH, maxCompressedBytes: MAX_ANNOUNCEMENT_LENGTH })
    const current = service(db, { get: (url, signal, identity) => {
      expect(url.href).toBe(ANNOUNCEMENT_URL)
      return bounded.get(new URL('/notice', origin), signal, identity)
    } })
    await current.start()
    await Promise.all([current.refresh(), current.refresh()])
    expect(headers).toHaveLength(2)
    for (const header of headers) {
      expect(header.cookie).toBeUndefined()
      expect(header.authorization).toBeUndefined()
      expect(Object.keys(header).sort()).toEqual(['accept', 'accept-encoding', 'connection', 'host', 'user-agent'])
    }
    mode = 'redirect'
    expect(await current.refresh()).toMatchObject({ outcome: 'network-error', source: 'cached' })
    expect(target).toBe(false)
    mode = 'large'
    expect(await current.refresh()).toMatchObject({ outcome: 'network-error', source: 'cached' })
  })
})
