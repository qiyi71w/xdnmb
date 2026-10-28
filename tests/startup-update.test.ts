import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createPendingInstallStore, removeFile, sha512OfFile } from '../src/main/updates/files'
import { installPendingUpdate } from '../src/main/updates/startup'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'xidao-startup-update-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function fixture() {
  const path = join(dir, 'xidao-0.2.0-win-x64.exe')
  const bytes = 'verified installer'
  writeFileSync(path, bytes)
  const ready = {
    release: { version: '0.2.0', releaseDate: null, notes: [], pageUrl: 'https://github.com/qiyi71w/xdnmb/releases/tag/v0.2.0' },
    sha512: createHash('sha512').update(bytes).digest('base64'), path
  }
  const pending = createPendingInstallStore(join(dir, 'update-on-start.json'))
  pending.save(ready)
  const launched: string[] = []
  const deps = { currentVersion: '0.1.0', pending, sha512: sha512OfFile, remove: removeFile, sessionEnding: () => false,
    async runInstaller(file: string) { launched.push(file) } }
  return { path, pending, launched, deps }
}

it('consumes a session-end package before launching and never tries it on a second launch', async () => {
  const f = fixture()
  expect(await installPendingUpdate(f.deps)).toEqual({ started: true, failure: null })
  expect(f.launched).toEqual([f.path])
  expect(f.pending.consume()).toBeNull()
  expect(await installPendingUpdate(f.deps)).toEqual({ started: false, failure: null })
  expect(f.launched).toEqual([f.path])
})

it('discards tampered packages, reports integrity failure, and consumes the attempt', async () => {
  const f = fixture()
  writeFileSync(f.path, 'tampered')
  expect(await installPendingUpdate(f.deps)).toEqual({ started: false, failure: 'integrity' })
  expect(existsSync(f.path)).toBe(false)
  expect(f.launched).toEqual([])
  expect(await installPendingUpdate(f.deps)).toEqual({ started: false, failure: null })
})

it('keeps the package when the installer cannot start, without another automatic attempt', async () => {
  const f = fixture()
  let attempts = 0
  f.deps.runInstaller = async () => { attempts++; throw new Error('cannot execute') }
  expect(await installPendingUpdate(f.deps)).toEqual({ started: false, failure: 'install' })
  expect(existsSync(f.path)).toBe(true)
  expect(await installPendingUpdate(f.deps)).toEqual({ started: false, failure: null })
  expect(attempts).toBe(1)
})

it('does not reinstall the running version or downgrade it', async () => {
  const f = fixture()
  f.deps.currentVersion = '0.3.0'
  expect(await installPendingUpdate(f.deps)).toEqual({ started: false, failure: null })
  expect(f.launched).toEqual([])
  expect(existsSync(f.path)).toBe(false)
})

it('does not execute a package when its one-shot marker cannot be consumed', async () => {
  const f = fixture()
  f.deps.pending = { ...f.pending, consume() { throw new Error('read-only filesystem') } }
  expect(await installPendingUpdate(f.deps)).toEqual({ started: false, failure: 'storage' })
  expect(f.launched).toEqual([])
  expect(existsSync(f.path)).toBe(true)
})

it('does not launch if Windows starts ending the session during checksum verification', async () => {
  const f = fixture()
  f.deps.sha512 = async path => {
    f.deps.sessionEnding = () => true
    return sha512OfFile(path)
  }
  expect(await installPendingUpdate(f.deps)).toEqual({ started: false, failure: null })
  expect(f.launched).toEqual([])
  expect(existsSync(f.path)).toBe(true)
})
