import { describe, expect, it } from 'vitest'
import { createLoginItemService, LOGIN_LAUNCH_ARG, type LoginItemDeps, type SystemLoginItem } from '../src/main/loginItem'

/** A system login item that takes writes as `accepts` says, around the real service. */
function setup(options: { platform: NodeJS.Platform; packaged?: boolean; argv?: string[]; item: SystemLoginItem; accepts?: (openAtLogin: boolean) => SystemLoginItem }) {
  let item = options.item
  const writes: Array<{ openAtLogin: boolean; args: readonly string[] }> = []
  const opened: string[] = []
  const deps: LoginItemDeps = {
    platform: options.platform,
    packaged: options.packaged ?? true,
    argv: options.argv ?? ['xidao.exe'],
    read: () => item,
    write(openAtLogin, args) {
      writes.push({ openAtLogin, args })
      if (options.accepts !== undefined) item = options.accepts(openAtLogin)
    },
    openExternal: async (url) => { opened.push(url) }
  }
  return { service: createLoginItemService(deps), writes, opened }
}

describe('开机自启 login item', () => {
  it('counts a Windows Run entry deactivated in Task Manager as off, and turning it on writes the login argument', () => {
    const s = setup({
      platform: 'win32',
      item: { openAtLogin: true, executableWillLaunchAtLogin: false },
      accepts: (openAtLogin) => ({ openAtLogin, executableWillLaunchAtLogin: openAtLogin })
    })
    expect(s.service.state()).toEqual({ available: true, enabled: false, needsApproval: false })
    expect(s.service.set(true)).toEqual({ applied: true, state: { available: true, enabled: true, needsApproval: false } })
    // The argument is stored in users' Run entries and must stay the same across versions.
    expect(s.writes).toEqual([{ openAtLogin: true, args: ['--xidao-login-launch'] }])
  })

  it('reports a write the system did not take as not applied, with what the system reports', () => {
    const s = setup({ platform: 'darwin', item: { openAtLogin: false, status: 'not-registered' }, accepts: () => ({ openAtLogin: false, status: 'not-found' }) })
    expect(s.service.set(true)).toEqual({ applied: false, state: { available: true, enabled: false, needsApproval: false } })
  })

  it('shows a macOS login item that needs approval, or was turned off in System Settings, as off with approval needed', async () => {
    const s = setup({ platform: 'darwin', item: { openAtLogin: false, status: 'not-registered' }, accepts: () => ({ openAtLogin: false, status: 'requires-approval' }) })
    expect(s.service.set(true)).toEqual({ applied: false, state: { available: true, enabled: false, needsApproval: true } })
    await s.service.openSystemSettings()
    expect(s.opened).toEqual(['x-apple.systempreferences:com.apple.LoginItems-Settings.extension'])
  })

  it('never registers a development run', () => {
    const s = setup({ platform: 'win32', packaged: false, argv: ['electron', '.', LOGIN_LAUNCH_ARG], item: { openAtLogin: true, executableWillLaunchAtLogin: true } })
    expect(s.service.set(true)).toEqual({ applied: false, state: { available: false, reason: 'unpackaged' } })
    expect(s.writes).toEqual([])
    expect(s.service.launchedAtLogin()).toBe(false)
  })

  it('knows a start by 开机自启 from the Windows argument or the macOS login launch only', () => {
    expect(setup({ platform: 'win32', argv: ['xidao.exe', LOGIN_LAUNCH_ARG], item: { openAtLogin: true } }).service.launchedAtLogin()).toBe(true)
    expect(setup({ platform: 'win32', argv: ['xidao.exe'], item: { openAtLogin: true, executableWillLaunchAtLogin: true } }).service.launchedAtLogin()).toBe(false)
    expect(setup({ platform: 'darwin', item: { openAtLogin: true, status: 'enabled', wasOpenedAtLogin: true } }).service.launchedAtLogin()).toBe(true)
    expect(setup({ platform: 'darwin', item: { openAtLogin: true, status: 'enabled', wasOpenedAtLogin: false } }).service.launchedAtLogin()).toBe(false)
  })
})
