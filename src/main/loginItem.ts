import type { LoginItemState } from '../shared/lifecycle'

/**
 * Passed by the Windows login item (its Run entry) only: the start it makes is a 开机自启. A start by
 * the user (shortcut, Start menu, installer) never carries it.
 */
export const LOGIN_LAUNCH_ARG = '--xidao-login-launch'

/** System Settings › 通用 › 登录项 (macOS 13+). */
const MAC_LOGIN_ITEMS_URL = 'x-apple.systempreferences:com.apple.LoginItems-Settings.extension'

/** The parts of `app.getLoginItemSettings()` read here. */
export interface SystemLoginItem {
  openAtLogin: boolean
  /** Windows: the Run entry exists and Task Manager / Windows Settings has not deactivated it. */
  executableWillLaunchAtLogin?: boolean
  /** macOS: `not-registered`, `enabled`, `requires-approval` or `not-found`. */
  status?: string
  /** macOS: this process was opened as a login item. */
  wasOpenedAtLogin?: boolean
}

export interface LoginItemDeps {
  platform: NodeJS.Platform
  /** False for a development run: its executable is Electron itself, never registered. */
  packaged: boolean
  argv: readonly string[]
  /** `app.getLoginItemSettings`; `args` are the Windows arguments to compare against (ignored on macOS). */
  read(args: readonly string[]): SystemLoginItem
  /** `app.setLoginItemSettings`; on Windows it also clears a deactivation made in Task Manager. */
  write(openAtLogin: boolean, args: readonly string[]): void
  openExternal(url: string): Promise<void>
}

export interface LoginItemService {
  state(): LoginItemState
  /** Writes the login item and reads it back; never throws. */
  set(enabled: boolean): { applied: boolean; state: LoginItemState }
  openSystemSettings(): Promise<void>
  /** This process was started by 开机自启. */
  launchedAtLogin(): boolean
}

const ARGS: readonly string[] = [LOGIN_LAUNCH_ARG]

/** 开机自启 read from and written to the system each time; nothing is kept in the app. */
export function createLoginItemService(deps: LoginItemDeps): LoginItemService {
  const { platform } = deps
  const supported = platform === 'win32' || platform === 'darwin'

  function state(): LoginItemState {
    if (!deps.packaged) return { available: false, reason: 'unpackaged' }
    if (!supported) return { available: false, reason: 'unsupported' }
    let item: SystemLoginItem
    try {
      item = deps.read(ARGS)
    } catch {
      return { available: true, enabled: false, needsApproval: false }
    }
    if (platform === 'win32') {
      return { available: true, enabled: item.openAtLogin && item.executableWillLaunchAtLogin === true, needsApproval: false }
    }
    if (item.status === undefined) return { available: true, enabled: item.openAtLogin, needsApproval: false }
    // `requires-approval` also follows the user turning it off in System Settings: it does not start.
    return { available: true, enabled: item.status === 'enabled', needsApproval: item.status === 'requires-approval' }
  }

  return {
    state,
    set(enabled) {
      const before = state()
      if (!before.available) return { applied: false, state: before }
      try {
        deps.write(enabled, ARGS)
      } catch {
        // What the system now reports decides; a write that threw usually changed nothing.
      }
      const after = state()
      return { applied: after.available && after.enabled === enabled, state: after }
    },
    async openSystemSettings() {
      if (platform === 'darwin') await deps.openExternal(MAC_LOGIN_ITEMS_URL)
    },
    launchedAtLogin() {
      if (!deps.packaged) return false
      if (platform === 'win32') return deps.argv.includes(LOGIN_LAUNCH_ARG)
      if (platform !== 'darwin') return false
      try {
        return deps.read(ARGS).wasOpenedAtLogin === true
      } catch {
        return false
      }
    }
  }
}
