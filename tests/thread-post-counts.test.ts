import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, expect, it } from 'vitest'
import type { PostTarget } from '../src/shared/drafts'
import type { PublicationState } from '../src/shared/publication'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'

const at = '2026-11-14T00:00:00.000Z'
const folders: string[] = []
const connections: ReadingDatabase[] = []

afterEach(() => {
  for (const db of connections.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'xidao-post-counts-'))
  folders.push(folder)
  const path = join(folder, 'reading.sqlite')
  const db = openReadingDatabase(path, undefined, { appVersion: '0.0.0-test' })
  connections.push(db)
  let request = 0
  /** `cookieId` null: a cookie imported before 饼干 IDs were kept. */
  const cookie = (name: string, cookieId: string | null) => {
    const id = db.insertCredential({ name, cookieId: cookieId ?? `${name}-placeholder`, source: 'raw', importedAt: at, ciphertext: Uint8Array.of(1) }).id
    if (cookieId === null) {
      const raw = new Database(path)
      try { raw.prepare('UPDATE credentials SET cookie_id = NULL WHERE id = ?').run(id) } finally { raw.close() }
    }
    return id
  }
  /** One send ending in `state`; `postId` names the confirmed post. */
  const send = (credentialId: string, target: PostTarget, state: PublicationState, postId?: string) => {
    const attempt = db.createPublication({
      requestId: `request-${++request}`, editorId: `editor-${request}`, forumId: '4', at,
      payload: { draftId: null, target, credentialId, fields: { content: `内容${request}`, title: '', name: '', watermark: false }, attachmentId: null }
    })
    if (state === 'sending') return
    const threadId = target.kind === 'reply' ? target.threadId : postId!
    db.finishPublication({ id: attempt.id, state, problem: state === 'confirmed' || state === 'unconfirmed' ? null : 'network',
      postId: state === 'confirmed' ? postId! : null, threadId: state === 'confirmed' ? threadId : null, at })
  }
  return { db, cookie, send }
}

const reply = (threadId: string): PostTarget => ({ kind: 'reply', threadId })
const newThread: PostTarget = { kind: 'thread', forumId: '4' }

it('counts sent replies and the main post per cookie in the thread, leaving unsent and other threads out', () => {
  const { db, cookie, send } = fixture()
  const alpha = cookie('甲', 'Alpha')
  const unnamed = cookie('乙', null)
  const idle = cookie('丙', 'Gamma')
  send(alpha, reply('100'), 'confirmed', '101')
  send(alpha, reply('100'), 'unconfirmed')
  send(alpha, reply('100'), 'failed')
  send(alpha, reply('100'), 'unknown')
  send(alpha, reply('100'), 'sending')
  send(alpha, reply('200'), 'confirmed', '201')
  send(unnamed, newThread, 'confirmed', '100')
  send(unnamed, reply('100'), 'confirmed', '102')
  // A sent new thread whose number was never learned belongs to no thread.
  send(idle, newThread, 'unconfirmed')

  expect(db.threadPostCounts('100')).toEqual([{ credentialId: alpha, count: 2 }, { credentialId: unnamed, count: 2 }])
  expect(db.threadPostCounts('200')).toEqual([{ credentialId: alpha, count: 1 }])
  expect(db.threadPostCounts('300')).toEqual([])
})

it('keeps a removed cookie’s sends for the cookie imported again with its 饼干 ID, not for one without an ID', () => {
  const { db, cookie, send } = fixture()
  const delta = cookie('丁', 'Delta')
  const unnamed = cookie('戊', null)
  send(delta, reply('100'), 'confirmed', '101')
  send(unnamed, reply('100'), 'confirmed', '102')
  expect(db.deleteCredential(delta)).toBe(true)
  expect(db.deleteCredential(unnamed)).toBe(true)
  expect(db.threadPostCounts('100')).toEqual([])

  const deltaAgain = cookie('丁', 'Delta')
  const unnamedAgain = cookie('戊', null)
  expect(deltaAgain).not.toBe(delta)
  expect(db.threadPostCounts('100')).toEqual([{ credentialId: deltaAgain, count: 1 }])
  expect(unnamedAgain).not.toBe(unnamed)
})
