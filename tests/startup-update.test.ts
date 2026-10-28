import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createInstallMarkerStore, createPendingInstallStore, removeFile, sha512OfFile } from '../src/main/updates/files'
import { exitInstallFailure, installPendingUpdate } from '../src/main/updates/startup'

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
  let consumedBeforeLaunch: boolean | null = null
  f.deps.runInstaller = async (file: string) => {
    consumedBeforeLaunch = f.pending.consume() === null
    f.launched.push(file)
  }
  // The installer ended while this process still runs: it did not install, and the package stays.
  expect(await installPendingUpdate(f.deps)).toEqual({ failure: 'incomplete' })
  expect(consumedBeforeLaunch).toBe(true)
  expect(existsSync(f.path)).toBe(true)
  expect(await installPendingUpdate(f.deps)).toEqual({ failure: null })
  expect(f.launched).toEqual([f.path])
})

it('discards tampered packages, reports integrity failure, and consumes the attempt', async () => {
  const f = fixture()
  writeFileSync(f.path, 'tampered')
  expect(await installPendingUpdate(f.deps)).toEqual({ failure: 'integrity' })
  expect(existsSync(f.path)).toBe(false)
  expect(f.launched).toEqual([])
  expect(await installPendingUpdate(f.deps)).toEqual({ failure: null })
})

it('keeps the package when the installer cannot start, without another automatic attempt', async () => {
  const f = fixture()
  let attempts = 0
  f.deps.runInstaller = async () => { attempts++; throw new Error('cannot execute') }
  expect(await installPendingUpdate(f.deps)).toEqual({ failure: 'install' })
  expect(existsSync(f.path)).toBe(true)
  expect(await installPendingUpdate(f.deps)).toEqual({ failure: null })
  expect(attempts).toBe(1)
})

it('does not reinstall the running version or downgrade it', async () => {
  const f = fixture()
  f.deps.currentVersion = '0.3.0'
  expect(await installPendingUpdate(f.deps)).toEqual({ failure: null })
  expect(f.launched).toEqual([])
  expect(existsSync(f.path)).toBe(false)
})

it('does not execute a package when its one-shot marker cannot be consumed', async () => {
  const f = fixture()
  f.deps.pending = { ...f.pending, consume() { throw new Error('read-only filesystem') } }
  expect(await installPendingUpdate(f.deps)).toEqual({ failure: 'storage' })
  expect(f.launched).toEqual([])
  expect(existsSync(f.path)).toBe(true)
})

it('does not launch if Windows starts ending the session during checksum verification', async () => {
  const f = fixture()
  f.deps.sha512 = async path => {
    f.deps.sessionEnding = () => true
    return sha512OfFile(path)
  }
  expect(await installPendingUpdate(f.deps)).toEqual({ failure: null })
  expect(f.launched).toEqual([])
  expect(existsSync(f.path)).toBe(true)
})

it('reports an installer started at the last quit that left an older version running, once', () => {
  const marker = createInstallMarkerStore(join(dir, 'update-launched.json'))
  marker.save('0.2.0')
  expect(exitInstallFailure(marker, '0.1.0')).toEqual({ when: 'exit', failure: 'incomplete' })
  expect(exitInstallFailure(marker, '0.1.0')).toBeNull()

  marker.save('0.2.0')
  expect(exitInstallFailure(marker, '0.2.0')).toBeNull()
  writeFileSync(join(dir, 'update-launched.json'), '{not json')
  expect(exitInstallFailure(marker, '0.1.0')).toBeNull()
  expect(existsSync(join(dir, 'update-launched.json'))).toBe(false)
})
