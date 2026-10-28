import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it } from 'vitest'
import { EMPTY_FIELDS, type DraftSaveInput, type PostTarget } from '../src/shared/drafts'
import { createDraftService, type DraftService } from '../src/main/drafts/service'
import { openManagedImageFiles, type ManagedImageFiles } from '../src/main/images/files'
import type { DraftStore, IdentityStore } from '../src/main/storage/contract'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'

const folders: string[] = []
const databases: ReadingDatabase[] = []

afterEach(() => {
  for (const db of databases.splice(0)) db.close()
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true })
})

function folder(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix))
  folders.push(path)
  return path
}

/** A real 2×1 PNG header with IHDR (enough for format and size detection). */
function pngBytes(seed = 0): Buffer {
  const bytes = Buffer.alloc(64, seed)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]).copy(bytes, 0)
  bytes.write('IHDR', 12, 'latin1')
  bytes.writeUInt32BE(2, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes
}

function asyncStore(db: ReadingDatabase): DraftStore & IdentityStore & { readonly status: ReadingDatabase['status'] } {
  return {
    get status() { return db.status },
    listDrafts: async () => db.listDrafts(),
    saveDraft: async (input, at) => db.saveDraft(input, at),
    deleteDraft: async (id) => db.deleteDraft(id),
    insertDraftAttachment: async (input) => db.insertDraftAttachment(input),
    getDraftAttachment: async (id) => db.getDraftAttachment(id),
    deleteUnreferencedAttachments: async (keep) => db.deleteUnreferencedAttachments(keep),
    listDraftAttachmentFileNames: async () => db.listDraftAttachmentFileNames(),
    getThreadPostIdentity: async (threadId) => db.getThreadPostIdentity(threadId),
    setThreadPostIdentity: async (threadId, id, at) => db.setThreadPostIdentity(threadId, id, at),
    listCredentials: async () => db.listCredentials(),
    loadCredentialCiphertexts: async () => db.loadCredentialCiphertexts(),
    loadCredentialCiphertext: async (id) => db.loadCredentialCiphertext(id),
    insertCredential: async (input) => db.insertCredential(input),
    renameCredential: async (id, name) => db.renameCredential(id, name),
    fillCredentialCookieId: async (id, cookieId, at) => db.fillCredentialCookieId(id, cookieId, at),
    setCredentialCookieId: async (id, cookieId, at) => db.setCredentialCookieId(id, cookieId, at),
    deleteCredential: async (id) => db.deleteCredential(id),
    reorderCredentials: async (ids) => db.reorderCredentials(ids),
    loadRoleSelections: async () => db.loadRoleSelections(),
    setRoleSelection: async (role, id) => db.setRoleSelection(role, id)
  }
}

interface Setup {
  db: ReadingDatabase
  files: ManagedImageFiles
  service: DraftService
  databasePath: string
  imageDirectory: string
}

async function setup(
  base = folder('xidao-drafts-'),
  copy?: (source: string, destination: string) => Promise<void>
): Promise<Setup> {
  const databasePath = join(base, 'xidao.sqlite')
  const imageDirectory = join(base, 'draft-images')
  const db = openReadingDatabase(databasePath)
  databases.push(db)
  const files = await openManagedImageFiles(imageDirectory)
  let tick = Date.parse('2026-10-24T00:00:00.000Z')
  const now = () => new Date((tick += 1000))
  return { db, files, service: createDraftService({ store: asyncStore(db), files, copy, now }), databasePath, imageDirectory }
}

function credential(db: ReadingDatabase, name: string): string {
  return db.insertCredential({ name, cookieId: `Id${name}`, source: 'raw', importedAt: '2026-10-24T00:00:00.000Z', ciphertext: Uint8Array.of(1, 2, 3) }).id
}

const replyA: PostTarget = { kind: 'reply', threadId: '50000001' }
const replyB: PostTarget = { kind: 'reply', threadId: '50000002' }

function input(patch: Partial<DraftSaveInput> = {}): DraftSaveInput {
  return { draftId: null, target: replyA, credentialId: null, fields: { ...EMPTY_FIELDS }, attachmentId: null, ...patch }
}

async function saved(service: DraftService, value: DraftSaveInput) {
  const result = await service.save(value)
  if (!result.ok) throw new Error(`save failed: ${result.reason}`)
  return result.draft
}

async function attached(service: DraftService, editorId: string, source: string) {
  const result = await service.attachImage('renderer', editorId, source)
  if (!result.ok) throw new Error(`attach failed: ${result.reason}`)
  return result.attachment
}

function managedNames(directory: string): string[] {
  return readdirSync(directory).sort()
}

async function list(service: DraftService) {
  const result = await service.list()
  if (!result.ok) throw new Error('list failed')
  return result.drafts
}

describe('saved drafts', () => {
  it('keeps several independent drafts for one target; saving replaces only that draft, whole', async () => {
    const { service } = await setup()
    const first = await saved(service, input({ fields: { ...EMPTY_FIELDS, content: '第一份' } }))
    const second = await saved(service, input({ fields: { ...EMPTY_FIELDS, content: '第二份' } }))
    expect(first.id).not.toBe(second.id)

    const replaced = await saved(service, input({
      draftId: first.id, target: replyB, fields: { ...EMPTY_FIELDS, content: '第一份改', title: '标题', watermark: true }
    }))
    expect(replaced).toMatchObject({ id: first.id, version: 2, target: replyB, createdAt: first.createdAt })
    expect(replaced.fields).toEqual({ ...EMPTY_FIELDS, content: '第一份改', title: '标题', watermark: true })

    const drafts = await list(service)
    expect(drafts.map((draft) => draft.id)).toEqual([first.id, second.id])
    expect(drafts.find((draft) => draft.id === second.id)).toMatchObject({ version: 1, target: replyA, fields: { content: '第二份' } })
  })

  it('refuses saving into a deleted draft instead of creating another one', async () => {
    const { service } = await setup()
    const draft = await saved(service, input({ fields: { ...EMPTY_FIELDS, content: 'x' } }))
    expect(await service.delete(draft.id)).toEqual({ ok: true })
    expect(await service.save(input({ draftId: draft.id }))).toEqual({ ok: false, reason: 'not-found' })
    expect(await list(service)).toEqual([])
  })

  it('a refused save (read-only storage) leaves the saved version and refuses attachments', async () => {
    const base = folder('xidao-drafts-')
    const { service, db, databasePath } = await setup(base)
    const draft = await saved(service, input({ fields: { ...EMPTY_FIELDS, content: '旧版' } }))
    db.close()
    const raw = new Database(databasePath)
    raw.pragma('user_version = 999')
    raw.close()

    const readOnly = await setup(base)
    expect(readOnly.db.status.state).toBe('read-only')
    expect(await readOnly.service.save(input({ draftId: draft.id, fields: { ...EMPTY_FIELDS, content: '新版' } })))
      .toEqual({ ok: false, reason: 'storage' })
    expect(await readOnly.service.delete(draft.id)).toEqual({ ok: false, reason: 'storage' })
    expect((await list(readOnly.service))[0]).toMatchObject({ id: draft.id, version: 1, fields: { content: '旧版' } })
    const source = join(base, 'pick.png')
    writeFileSync(source, pngBytes())
    expect(await readOnly.service.attachImage('renderer', 'e1', source)).toEqual({ ok: false, reason: 'storage' })
  })

  it('reports storage failure when nothing can be read rather than an empty library', async () => {
    const base = folder('xidao-drafts-')
    writeFileSync(join(base, 'xidao.sqlite'), 'not a database')
    const { service, db } = await setup(base)
    expect(db.status.state).toBe('unavailable')
    expect(await service.list()).toEqual({ ok: false, reason: 'storage' })
    expect(await service.identityFor(replyA)).toEqual({ source: 'unknown' })
  })
})

describe('attachment copies', () => {
  it('copies the chosen image, never touches the original, and restores text, identity and image after restart', async () => {
    const base = folder('xidao-drafts-')
    const user = folder('xidao-user-')
    const original = join(user, '我的图.png')
    writeFileSync(original, pngBytes(7))
    const first = await setup(base)
    const cookie = credential(first.db, '饼干甲')
    const attachment = await attached(first.service, 'e1', original)
    expect(attachment).toMatchObject({ format: 'png', width: 2, height: 1, originalName: '我的图.png' })
    expect(attachment.url).toMatch(/^xidao-image:\/\/draft\/[0-9a-f]{32}\.png$/)
    const draft = await saved(first.service, input({
      credentialId: cookie, fields: { ...EMPTY_FIELDS, content: '带图' }, attachmentId: attachment.id
    }))
    await first.service.releaseOwner('renderer')
    first.db.close()

    const restarted = await setup(base)
    await restarted.service.recover()
    const [restored] = await list(restarted.service)
    expect(restored).toMatchObject({ id: draft.id, credentialId: cookie, fields: { content: '带图' }, attachment: { id: attachment.id } })
    const name = restored?.attachment?.url.split('/').at(-1) ?? ''
    expect(readFileSync(join(restarted.imageDirectory, name))).toEqual(pngBytes(7))
    expect(readFileSync(original)).toEqual(pngBytes(7))
  })

  it('protects copies an editor shows or a draft references; reclaims the rest, never the user file', async () => {
    const { service, imageDirectory } = await setup()
    const user = folder('xidao-user-')
    const original = join(user, 'a.png')
    writeFileSync(original, pngBytes(1))

    const shown = await attached(service, 'e1', original)
    const other = await attached(service, 'e2', original)
    // Another editor's activity reclaims; e1's unsaved copy stays.
    await service.releaseEditor('renderer', 'e2')
    expect(managedNames(imageDirectory)).toHaveLength(1)

    const draft = await saved(service, input({ attachmentId: shown.id, fields: { ...EMPTY_FIELDS, content: 'x' } }))
    // The editor replaces the image without saving: the saved version still references the first copy.
    const replacement = await attached(service, 'e1', original)
    expect(managedNames(imageDirectory)).toHaveLength(2)
    // The editor shows the saved image again: the unsaved replacement is reclaimed.
    await service.holdAttachment('renderer', 'e1', shown.id)
    expect(managedNames(imageDirectory)).toHaveLength(1)
    expect(await service.save(input({ attachmentId: replacement.id }))).toEqual({ ok: false, reason: 'attachment-missing' })
    expect(await service.save(input({ attachmentId: other.id }))).toEqual({ ok: false, reason: 'attachment-missing' })

    await service.releaseEditor('renderer', 'e1')
    expect(managedNames(imageDirectory)).toHaveLength(1)
    await service.delete(draft.id)
    expect(managedNames(imageDirectory)).toEqual([])
    expect(readFileSync(original)).toEqual(pngBytes(1))
  })

  it('keeps a deleted draft’s image while its undo holds it, restores the draft with it, and reclaims it once the undo is gone', async () => {
    const { service, imageDirectory } = await setup()
    const user = folder('xidao-user-')
    const original = join(user, 'a.png')
    writeFileSync(original, pngBytes(3))
    const image = await attached(service, 'e1', original)
    const draft = await saved(service, input({ attachmentId: image.id, fields: { ...EMPTY_FIELDS, content: '带图' } }))

    // Delete with undo: the undo hold comes first, then the editor lets go of the image.
    await service.holdAttachment('renderer', 'undo-1', image.id)
    expect(await service.delete(draft.id)).toEqual({ ok: true })
    await service.holdAttachment('renderer', 'e1', null)
    expect(managedNames(imageDirectory)).toHaveLength(1)
    expect(await list(service)).toEqual([])
    // 撤销: the content comes back as a draft with the same image; the undo hold can go.
    const restored = await saved(service, input({ attachmentId: image.id, fields: { ...EMPTY_FIELDS, content: '带图' } }))
    await service.releaseEditor('renderer', 'undo-1')
    expect((await list(service)).map((item) => [item.id, item.attachment?.id])).toEqual([[restored.id, image.id]])
    expect(managedNames(imageDirectory)).toHaveLength(1)

    // Deleted again and the notice goes away without 撤销: the copy is reclaimed, the user file stays.
    await service.holdAttachment('renderer', 'undo-2', image.id)
    expect(await service.delete(restored.id)).toEqual({ ok: true })
    expect(managedNames(imageDirectory)).toHaveLength(1)
    await service.releaseEditor('renderer', 'undo-2')
    expect(managedNames(imageDirectory)).toEqual([])
    expect(await service.save(input({ attachmentId: image.id }))).toEqual({ ok: false, reason: 'attachment-missing' })
    expect(readFileSync(original)).toEqual(pngBytes(3))
  })

  it('a save whose image copy disappeared fails explicitly and keeps the previous version', async () => {
    const { service, imageDirectory } = await setup()
    const user = folder('xidao-user-')
    const original = join(user, 'a.png')
    writeFileSync(original, pngBytes())
    const draft = await saved(service, input({ fields: { ...EMPTY_FIELDS, content: '旧版' } }))
    const attachment = await attached(service, 'e1', original)
    for (const name of managedNames(imageDirectory)) rmSync(join(imageDirectory, name))

    expect(await service.save(input({ draftId: draft.id, attachmentId: attachment.id, fields: { ...EMPTY_FIELDS, content: '新版' } })))
      .toEqual({ ok: false, reason: 'attachment-missing' })
    expect((await list(service))[0]).toMatchObject({ version: 1, fields: { content: '旧版' }, attachment: null })
  })

  it('classifies unreadable, non-image and full-disk attachments and leaves no partial files', async () => {
    const user = folder('xidao-user-')
    const text = join(user, 'note.png')
    writeFileSync(text, '<html>not an image</html>')
    const image = join(user, 'a.png')
    writeFileSync(image, pngBytes())
    mkdirSync(join(user, 'dir.png'))

    const { service, imageDirectory } = await setup()
    expect(await service.attachImage('renderer', 'e1', null)).toEqual({ ok: false, reason: 'cancelled' })
    expect(await service.attachImage('renderer', 'e1', join(user, 'gone.png'))).toEqual({ ok: false, reason: 'source-unreadable' })
    expect(await service.attachImage('renderer', 'e1', join(user, 'dir.png'))).toEqual({ ok: false, reason: 'source-unreadable' })
    expect(await service.attachImage('renderer', 'e1', text)).toEqual({ ok: false, reason: 'not-image' })
    expect(managedNames(imageDirectory)).toEqual([])

    const full = await setup(undefined, async (_source, destination) => {
      writeFileSync(destination, 'partial')
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
    })
    expect(await full.service.attachImage('renderer', 'e1', image)).toEqual({ ok: false, reason: 'no-space' })
    expect(managedNames(full.imageDirectory)).toEqual([])
    expect(readFileSync(image)).toEqual(pngBytes())
    expect(existsSync(text)).toBe(true)
  })

  it('startup recovery removes unreferenced copies and leftover files but keeps referenced ones', async () => {
    const base = folder('xidao-drafts-')
    const user = folder('xidao-user-')
    const original = join(user, 'a.png')
    writeFileSync(original, pngBytes())
    const first = await setup(base)
    const kept = await attached(first.service, 'e1', original)
    await attached(first.service, 'e2', original)
    await saved(first.service, input({ attachmentId: kept.id }))
    first.db.close()
    writeFileSync(join(base, 'draft-images', `${'a'.repeat(32)}.part`), 'x')
    writeFileSync(join(base, 'draft-images', `${'b'.repeat(32)}.png`), 'x')

    const restarted = await setup(base)
    await restarted.service.recover()
    const names = managedNames(restarted.imageDirectory)
    expect(names).toEqual(restarted.db.listDraftAttachmentFileNames())
    expect(names).toHaveLength(1)
    expect((await list(restarted.service))[0]?.attachment?.id).toBe(kept.id)
  })
})

describe('发言饼干 choice', () => {
  it('a thread selection wins over the global default for that thread only and changes nothing else', async () => {
    const { service, db } = await setup()
    const a = credential(db, '甲')
    const b = credential(db, '乙')
    expect(await service.identityFor(replyA)).toEqual({ source: 'default', selection: { state: 'none' } })
    db.setRoleSelection('default-post', a)
    expect(await service.selectThreadIdentity(replyA.threadId, b)).toEqual({ ok: true })

    expect(await service.identityFor(replyA)).toEqual({ source: 'thread', selection: { state: 'selected', credentialId: b } })
    expect(await service.identityFor(replyB)).toEqual({ source: 'default', selection: { state: 'selected', credentialId: a } })
    expect(await service.identityFor({ kind: 'thread', forumId: '4' }))
      .toEqual({ source: 'default', selection: { state: 'selected', credentialId: a } })
    expect(db.loadRoleSelections()['default-post']).toEqual({ state: 'selected', credentialId: a })

    // Changing the global default afterwards affects threads without their own selection only.
    db.setRoleSelection('default-post', b)
    expect(await service.identityFor(replyB)).toEqual({ source: 'default', selection: { state: 'selected', credentialId: b } })
    expect(await service.selectThreadIdentity(replyA.threadId, '999')).toEqual({ ok: false, reason: 'not-found' })
  })

  it('a removed thread selection stays missing and never falls back to the global default', async () => {
    const { service, db } = await setup()
    const a = credential(db, '甲')
    const b = credential(db, '乙')
    db.setRoleSelection('default-post', a)
    await service.selectThreadIdentity(replyA.threadId, b)
    db.deleteCredential(b)
    expect(await service.identityFor(replyA)).toEqual({ source: 'thread', selection: { state: 'missing', credentialId: b } })

    const draft = await saved(service, input({ credentialId: a }))
    db.deleteCredential(a)
    expect((await list(service)).find((item) => item.id === draft.id)?.credentialId).toBe(a)
    expect(await service.identityFor(replyB)).toEqual({ source: 'default', selection: { state: 'missing', credentialId: a } })
  })
})
