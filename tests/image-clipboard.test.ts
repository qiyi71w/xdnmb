import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createOriginalClipboard, type DecodedOriginal } from '../src/main/images/clipboard'
import { openManagedImageFiles, type ManagedImageFiles } from '../src/main/images/files'
import { createImageService } from '../src/main/images/service'
import { openReadingDatabase, type ReadingDatabase } from '../src/main/storage/database'
import type { Post } from '../src/shared/forum'
import { asStore } from './helpers/store'

// Two complete GIF frames, red then blue, with 500ms delays and an infinite loop.
const GIF = Buffer.from('47494638396101000100800000ff00000000ff21ff0b4e45545343415045322e30030100000021f90400320000002c000000000100010000020244010021f90400320000002c00000000010001000002024c01003b', 'hex')
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLttAAAAABJRU5ErkJggg==', 'base64')
let dir: string
let files: ManagedImageFiles
let db: ReadingDatabase
let uri: string | null
let png: Uint8Array | null
let rejectWrite: boolean
let decode: (bytes: Buffer) => Promise<DecodedOriginal>

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'xidao-clipboard-'))
  files = await openManagedImageFiles(join(dir, 'clipboard'))
  db = openReadingDatabase(join(dir, 'db.sqlite'))
  uri = null; png = null; rejectWrite = false
  decode = async (bytes) => ({ width: 1, height: 1, animated: bytes.subarray(0, 3).toString() === 'GIF', png: PNG })
})
afterEach(() => { db.close(); rmSync(dir, { recursive: true, force: true }) })

function clipboard() {
  return createOriginalClipboard({
    files,
    decode: (bytes) => decode(bytes),
    async writeImage(data) { if (rejectWrite) throw new Error('OS clipboard busy'); png = data; uri = null },
    async writeFiles(value) { if (rejectWrite) throw new Error('OS clipboard busy'); uri = value; png = null },
    async referencedFiles() { return new Set(uri === null ? [] : [basename(fileURLToPath(uri))]) }
  })
}
function source(body = GIF, name = 'source.png') { const path = join(dir, name); writeFileSync(path, body); return path }
function post(): Post {
  return { id: '10', forumId: '4', createdAt: null, userHash: null, name: null, title: null, isAdmin: null, isSage: null, content: [], plainText: '', image: { path: '2026-10-30/image', ext: '.png' } }
}

describe('original clipboard lifetime', () => {
  it('preserves both encoded frames by content, survives restart, and recovers replaced references only', async () => {
    const first = clipboard()
    expect(await first.copy(source())).toEqual({ status: 'copied', representation: 'file' })
    const copied = fileURLToPath(uri!)
    expect(copied.endsWith('.gif')).toBe(true)
    expect(readFileSync(copied)).toEqual(GIF)
    const other = join(files.directory, 'do-not-touch.txt')
    writeFileSync(other, 'user')
    const link = join(files.directory, 'a'.repeat(32) + '.gif')
    symlinkSync(other, link)
    await clipboard().recover()
    expect(existsSync(copied)).toBe(true)
    uri = null
    await clipboard().recover()
    expect(existsSync(copied)).toBe(false)
    expect(readFileSync(other, 'utf8')).toBe('user')
    expect(readdirSync(files.directory).sort()).toEqual([basename(link), basename(other)].sort())
  })

  it('prepares then commits once; failed replacement preserves old clipboard and protected file', async () => {
    const service = clipboard()
    await service.copy(source())
    const old = uri
    rejectWrite = true
    expect(await service.copy(source(GIF, 'next.gif'))).toEqual({ status: 'failed' })
    expect(uri).toBe(old)
    expect(readdirSync(files.directory)).toEqual([basename(fileURLToPath(old!))])
    rejectWrite = false
    expect(await service.copy(source(PNG, 'static.gif'))).toEqual({ status: 'copied', representation: 'image' })
    expect(png).toEqual(PNG)
    expect(existsSync(fileURLToPath(old!))).toBe(false)
  })

  it('rejects malformed, oversized-header, symlinked and undecodable input without writing', async () => {
    const service = clipboard()
    expect(await service.copy(source(Buffer.from('<html>not an image')))).toEqual({ status: 'invalid-image' })
    const oversized = Buffer.from(PNG); oversized.writeUInt32BE(32768, 16)
    expect(await service.copy(source(oversized, 'oversized.png'))).toEqual({ status: 'invalid-image' })
    const target = source()
    // Windows ignores O_NOFOLLOW; there the caller's lstat check (images service) refuses links.
    if (process.platform !== 'win32') {
      const link = join(dir, 'link.gif'); symlinkSync(target, link)
      expect(await service.copy(link)).toEqual({ status: 'failed' })
    }
    decode = async () => { throw new Error('corrupt compressed data') }
    expect(await service.copy(target)).toEqual({ status: 'invalid-image' })
    expect(uri).toBeNull(); expect(png).toBeNull()
    expect(readdirSync(files.directory)).toEqual([])
  })

  it('guards simultaneous requests and recovery while preparing the next copy', async () => {
    const gate = Promise.withResolvers<DecodedOriginal>()
    decode = () => gate.promise
    const service = clipboard()
    const copying = service.copy(source())
    expect(await service.copy(source(GIF, 'duplicate.gif'))).toEqual({ status: 'busy' })
    await service.recover()
    gate.resolve({ width: 1, height: 1, animated: true, png: null })
    expect(await copying).toEqual({ status: 'copied', representation: 'file' })
    expect(existsSync(fileURLToPath(uri!))).toBe(true)
  })

  it('keeps all residues if native ownership cannot be read and cleans them on a later successful recovery', async () => {
    const service = clipboard(); await service.copy(source())
    const retained = fileURLToPath(uri!)
    const failed = createOriginalClipboard({ files, decode, writeImage: async () => undefined, writeFiles: async () => undefined, referencedFiles: async () => { throw new Error('clipboard unavailable') } })
    await expect(failed.recover()).rejects.toThrow('clipboard unavailable')
    expect(existsSync(retained)).toBe(true)
    uri = null; await service.recover()
    expect(existsSync(retained)).toBe(false)
  })

  it('only copies the matched stored original; closing viewers and cache clearing preserve its separate spool', async () => {
    const images = await openManagedImageFiles(join(dir, 'images'))
    const partial = images.partialPath(); writeFileSync(partial, GIF)
    const name = await images.commit(partial, 'gif')
    db.savePost(post(), '2026-10-30T00:00:00Z')
    const resource = db.commitImageResource({ kind: 'original', sourceUrl: 'https://image.example/image/2026-10-30/image.png', fileName: name, format: 'gif', bytes: GIF.length, width: 1, height: 1, fetchedAt: '2026-10-30T00:00:00Z' }, [])
    const service = createImageService({ store: asStore(db), files: images, origin: 'https://image.example', clipboard: clipboard(), download: async () => { throw new Error('must not download') } })
    expect(await service.copyOriginal('10', 'file:///etc/passwd')).toEqual({ status: 'not-loaded' })
    expect(await service.copyOriginal('10', `xidao-image://file/${'f'.repeat(32)}.gif`)).toEqual({ status: 'not-loaded' })
    expect(await service.copyOriginal('10', `xidao-image://file/${name}`)).toEqual({ status: 'copied', representation: 'file' })
    const copied = fileURLToPath(uri!)
    await service.releaseView('1', 'viewer')
    expect(await service.prune([resource.resource.id])).toEqual([name])
    expect(existsSync(images.pathOf(name)!)).toBe(false)
    expect(readFileSync(copied)).toEqual(GIF)
    await clipboard().recover()
    expect(readFileSync(copied)).toEqual(GIF)
  })

  it('never substitutes a thumbnail and releases only its own holder after a failed copy', async () => {
    const images = await openManagedImageFiles(join(dir, 'images'))
    const partial = images.partialPath(); writeFileSync(partial, GIF)
    const name = await images.commit(partial, 'gif')
    db.savePost(post(), '2026-10-30T00:00:00Z')
    const saved = { sourceUrl: 'https://image.example/image/2026-10-30/image.png', fileName: name, format: 'gif' as const, bytes: GIF.length, width: 1, height: 1, fetchedAt: '2026-10-30T00:00:00Z' }
    db.commitImageResource({ ...saved, kind: 'thumb' }, [])
    const service = createImageService({ store: asStore(db), files: images, origin: 'https://image.example', clipboard: clipboard(), download: async () => { throw new Error('must not download') } })
    expect(await service.copyOriginal('10', `xidao-image://file/${name}`)).toEqual({ status: 'not-loaded' })
    const originalPartial = images.partialPath(); writeFileSync(originalPartial, GIF)
    const originalName = await images.commit(originalPartial, 'gif')
    const original = db.commitImageResource({ ...saved, fileName: originalName, kind: 'original' }, [{ kind: 'offline', id: 'other-copy' }])
    rejectWrite = true
    expect(await service.copyOriginal('10', `xidao-image://file/${originalName}`)).toEqual({ status: 'failed' })
    expect(await service.prune([original.resource.id])).toEqual([])
    expect(existsSync(images.pathOf(originalName)!)).toBe(true)
    expect(uri).toBeNull()
    db.releaseImageHolders('offline', 'other-copy')
    expect(await service.prune([original.resource.id])).toEqual([originalName])
  })
})
