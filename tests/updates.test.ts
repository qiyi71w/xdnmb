import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineCheck, UpdateEngine } from '../src/main/updates/engine'
import { createRecordStore, removeFile, sha512OfFile } from '../src/main/updates/files'
import { createUpdateService, type UpdateSettings } from '../src/main/updates/service'
import type { UpdatePlatform, UpdateState } from '../src/shared/updates'

const DAY = 24 * 60 * 60 * 1000
const BYTES = Buffer.from('xidao 0.2.0 installer')
const SHA = createHash('sha512').update(BYTES).digest('base64')
const FOUND: EngineCheck = {
  kind: 'newer',
  release: { info: { version: '0.2.0', releaseDate: '2026-10-27T00:00:00.000Z', notes: [], pageUrl: 'https://github.com/qiyi71w/xdnmb/releases/tag/v0.2.0' }, sha512: SHA }
}
const settings = (patch: Partial<UpdateSettings> = {}): UpdateSettings =>
  ({ updateAutoCheck: true, updateAutoInstall: false, updateAutoDownload: false, updateNetwork: 'system', ...patch })

let dir: string
const packagePath = () => join(dir, 'pending', 'xidao-0.2.0-win-x64.exe')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'xidao-updates-'))
  vi.useFakeTimers({ now: Date.parse('2026-10-27T08:00:00.000Z'), toFake: ['setTimeout', 'clearTimeout', 'Date'] })
})
afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** Lets settled promise chains run (setImmediate stays real). */
const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** Controlled engine: `result` is what a check returns; downloads write the package, or wait while held. */
function fakeEngine() {
  let next: EngineCheck | Error = FOUND
  let hold: PromiseWithResolvers<void> | null = null
  const engine = {
    checks: 0,
    downloads: 0,
    networks: [] as string[],
    set result(value: EngineCheck | Error) { next = value },
    holdDownloads() { hold = Promise.withResolvers<void>() },
    releaseDownloads() { hold?.resolve() },
    api: {
      async setNetwork(mode) { engine.networks.push(mode) },
      async check() {
        engine.checks++
        if (next instanceof Error) throw next
        return next
      },
      async download(onProgress, signal) {
        engine.downloads++
        const pending = hold
        if (pending !== null) {
          const aborted = Promise.withResolvers<never>()
          signal.addEventListener('abort', () => aborted.reject(new Error('cancelled')))
          onProgress(5, BYTES.length)
          await Promise.race([pending.promise, aborted.promise])
        }
        writeFileSync(packagePath(), BYTES)
        onProgress(BYTES.length, BYTES.length)
        return packagePath()
      }
    } satisfies UpdateEngine
  }
  return engine
}

/**
 * A service on `dir`. The stored record and package start empty, unless `restarted` (a later start
 * of the same installation, keeping both).
 */
function service(engine: ReturnType<typeof fakeEngine>, options: { platform?: UpdatePlatform; version?: string; restarted?: boolean } = {}) {
  if (options.restarted !== true) {
    rmSync(join(dir, 'pending'), { recursive: true, force: true })
    rmSync(join(dir, 'update-state.json'), { force: true })
  }
  mkdirSync(join(dir, 'pending'), { recursive: true })
  const states: UpdateState[] = []
  const installers: Array<{ path: string; restart: boolean }> = []
  let installQuits = 0
  const instance = createUpdateService({
    platform: options.platform ?? 'windows',
    unavailable: null,
    currentVersion: options.version ?? '0.1.0',
    engine: engine.api,
    records: createRecordStore(join(dir, 'update-state.json')),
    sha512: sha512OfFile,
    remove: removeFile,
    async runInstaller(path, restart) { installers.push({ path, restart }) },
    async openPackage() {},
    requestInstallQuit: () => { installQuits++ },
    publish: (state) => states.push(state)
  })
  return { instance, states, installers, get installQuits() { return installQuits } }
}

describe('software updates', () => {
  it('checks at cold start and again only after 24 hours; a check while one runs starts no second one', async () => {
    const engine = fakeEngine()
    const { instance } = service(engine)
    await instance.start(settings())
    expect(engine.checks).toBe(1)
    expect(instance.state().lastCheck?.outcome).toBe('available')

    await vi.advanceTimersByTimeAsync(DAY - 60_000)
    expect(engine.checks).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(engine.checks).toBe(2)

    engine.result = { kind: 'up-to-date' }
    await Promise.all([instance.check(), instance.check()])
    expect(engine.checks).toBe(3)
    expect(instance.state().lastCheck?.outcome).toBe('up-to-date')
    expect(instance.state().release).toBeNull()
  })

  it('does nothing automatically when automatic checks are off, keeps the manual check, and reports a failure as a failure', async () => {
    const engine = fakeEngine()
    const { instance } = service(engine)
    await instance.start(settings({ updateAutoCheck: false }))
    await vi.advanceTimersByTimeAsync(3 * DAY)
    expect(engine.checks).toBe(0)

    engine.result = new Error('net::ERR_INTERNET_DISCONNECTED')
    await instance.check()
    expect(instance.state().lastCheck).toMatchObject({ outcome: 'failed', failure: 'network' })
    expect(instance.state().release).toBeNull()

    engine.result = FOUND
    instance.configure(settings({ updateAutoCheck: true, updateNetwork: 'direct' }))
    await vi.advanceTimersByTimeAsync(DAY)
    expect(engine.checks).toBe(2)
    expect(engine.networks.at(-1)).toBe('direct')
  })

  it('downloads automatically only with the platform setting on; a cancelled download is not restarted automatically in this run', async () => {
    const off = fakeEngine()
    await service(off).instance.start(settings())
    expect(off.downloads).toBe(0)

    const engine = fakeEngine()
    engine.holdDownloads()
    const { instance } = service(engine)
    const started = instance.start(settings({ updateAutoInstall: true }))
    await settle()
    await settle()
    expect(instance.state().release?.download).toMatchObject({ status: 'downloading', transferred: 5 })
    instance.cancelDownload()
    await started
    expect(instance.state().release?.download).toEqual({ status: 'none', failure: null, cancelled: true })

    await vi.advanceTimersByTimeAsync(DAY)
    expect(engine.checks).toBe(2)
    expect(engine.downloads).toBe(1)

    engine.releaseDownloads()
    await instance.download()
    expect(instance.state().release?.download).toEqual({ status: 'ready' })
    expect(instance.state().installOnQuit).toBe(true)
  })

  it('keeps a verified package across a restart without checking, and drops one whose bytes changed', async () => {
    await service(fakeEngine()).instance.start(settings({ updateAutoInstall: true }))

    const offline = fakeEngine()
    const second = service(offline, { restarted: true })
    await second.instance.start(settings({ updateAutoCheck: false }))
    expect(offline.checks).toBe(0)
    expect(second.instance.state().release?.download.status).toBe('ready')
    expect(second.instance.state().notice).toEqual({ version: '0.2.0', kind: 'ready' })

    writeFileSync(packagePath(), 'tampered')
    const third = service(fakeEngine(), { restarted: true })
    await third.instance.start(settings({ updateAutoCheck: false }))
    expect(third.instance.state().release).toBeNull()
    expect(existsSync(packagePath())).toBe(false)
  })

  it('removes the package once its version is the one running', async () => {
    await service(fakeEngine()).instance.start(settings({ updateAutoInstall: true }))
    const upgraded = service(fakeEngine(), { version: '0.2.0', restarted: true })
    await upgraded.instance.start(settings({ updateAutoCheck: false }))
    expect(upgraded.instance.state().release).toBeNull()
    expect(existsSync(packagePath())).toBe(false)
  })

  it('installs at exit only for an install quit, or an ordinary quit with automatic install on; never at a session end or with a changed package', async () => {
    const cases: Array<[Partial<UpdateSettings>, 'quit' | 'install' | 'session-end', boolean[]]> = [
      [{ updateAutoInstall: false }, 'quit', []],
      [{ updateAutoInstall: true }, 'quit', [false]],
      [{ updateAutoInstall: false }, 'install', [true]],
      [{ updateAutoInstall: true }, 'session-end', []]
    ]
    for (const [patch, reason, restarts] of cases) {
      const s = service(fakeEngine())
      await s.instance.start(settings({ updateAutoInstall: true }))
      s.instance.configure(settings(patch))
      await s.instance.prepareExit(reason)
      await s.instance.launchInstaller()
      expect(s.installers.map(({ restart }) => restart)).toEqual(restarts)
    }

    const changed = service(fakeEngine())
    await changed.instance.start(settings({ updateAutoInstall: true }))
    writeFileSync(packagePath(), 'tampered')
    await changed.instance.prepareExit('install')
    await changed.instance.launchInstaller()
    expect(changed.installers).toEqual([])
    expect(changed.instance.state().release?.download).toEqual({ status: 'none', failure: 'integrity', cancelled: false })
  })

  it('starts the install quit only with a confirmed package; macOS opens the package and never installs', async () => {
    const waiting = service(fakeEngine())
    await waiting.instance.start(settings())
    expect(await waiting.instance.installAndRestart()).toEqual({ started: false, failure: 'not-ready' })
    expect(waiting.installQuits).toBe(0)

    const ready = service(fakeEngine())
    await ready.instance.start(settings({ updateAutoInstall: true }))
    expect(await ready.instance.installAndRestart()).toEqual({ started: true })
    expect(ready.installQuits).toBe(1)

    const mac = service(fakeEngine(), { platform: 'mac' })
    await mac.instance.start(settings({ updateAutoDownload: true }))
    expect(mac.instance.state().release?.download.status).toBe('ready')
    expect(mac.instance.state().installOnQuit).toBe(false)
    expect(await mac.instance.installAndRestart()).toEqual({ started: false, failure: 'not-ready' })
    await mac.instance.prepareExit('quit')
    await mac.instance.launchInstaller()
    expect(mac.installers).toEqual([])
    expect(await mac.instance.openInstaller()).toEqual({ started: true })
  })

  it('shows the new-version notice once per version, also across restarts', async () => {
    const first = service(fakeEngine())
    await first.instance.start(settings())
    expect(first.instance.state().notice).toEqual({ version: '0.2.0', kind: 'available' })
    await first.instance.acknowledgeNotice('0.2.0')
    expect(first.instance.state().notice).toBeNull()
    await first.instance.check()
    expect(first.instance.state().notice).toBeNull()

    const second = service(fakeEngine(), { restarted: true })
    await second.instance.start(settings())
    expect(second.instance.state().notice).toBeNull()
    expect(second.instance.state().release?.info.version).toBe('0.2.0')
  })
})
