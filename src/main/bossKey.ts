import type { BossKeyStatus } from '../shared/bossKey'
import type { AppSettings } from '../shared/settings'

export interface BossKeyDeps {
  platform: NodeJS.Platform
  /**
   * `globalShortcut.register`: false (or a throw) when the system refuses the combination, usually
   * because another program already holds it.
   */
  register(accelerator: string, pressed: () => void): boolean
  unregister(accelerator: string): void
  /** The registered combination was pressed. */
  pressed(): void
}

export interface BossKeyService {
  /** Applies the saved 老板键 settings (at start and after every settings change). */
  configure(settings: Pick<AppSettings, 'bossKeyEnabled' | 'bossKey'>): void
  /** Status for the settings page; an enabled 老板键 the system refused is registered again first. */
  status(): BossKeyStatus
  /** While recording a new combination the registered one is released, so pressing it reaches the page. */
  setRecording(recording: boolean): BossKeyStatus
  /** The settings page is recording a combination: the window's own key handling stays out of its way. */
  readonly recording: boolean
}

/**
 * 老板键 registration with the system (Windows and macOS only). A refused combination stays turned on
 * and is tried again at start, on every settings change and whenever the settings page asks.
 */
export function createBossKeyService(deps: BossKeyDeps): BossKeyService {
  const supported = deps.platform === 'win32' || deps.platform === 'darwin'
  let enabled = false
  let accelerator = ''
  let recording = false
  /** What is registered with the system right now. */
  let registered: string | null = null

  function apply(): void {
    const wanted = supported && enabled && !recording ? accelerator : null
    if (registered !== null && registered !== wanted) {
      deps.unregister(registered)
      registered = null
    }
    if (wanted === null || registered !== null) return
    let ok = false
    try {
      ok = deps.register(wanted, deps.pressed)
    } catch {
      // An accelerator Electron cannot parse counts as refused; stored values are validated already.
    }
    if (ok) registered = wanted
  }

  function status(): BossKeyStatus {
    if (!supported) return 'unsupported'
    if (!enabled) return 'off'
    // While recording nothing is registered on purpose; it is not refused.
    return registered !== null || recording ? 'active' : 'unavailable'
  }

  return {
    get recording() {
      return recording
    },
    configure(settings) {
      enabled = settings.bossKeyEnabled
      accelerator = settings.bossKey
      apply()
    },
    status() {
      apply()
      return status()
    },
    setRecording(next) {
      recording = next
      apply()
      return status()
    }
  }
}
