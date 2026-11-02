import type { CloseAction, LifecycleRequest } from '../../shared/lifecycle'
import type { PublicationAttempt } from '../../shared/publication'
import type { PublicationService } from '../publication/service'

/**
 * Explicit opening of the app, for checks that run on cold start or explicit reopen (reminders).
 * Ordinary focus, restoring a minimized window and system wake are not triggers; the several
 * ready / activate / show events of one start produce a single `cold-start`.
 */
export type LaunchTrigger = 'cold-start' | 'reopen'

/**
 * - `starting`: the first window is being created.
 * - `running`: normal, with the window shown or resident (hidden).
 * - `quitting`: the renderer is handling unsaved editors and saving the workspace.
 * - `finishing`: the window is closed; sends that already started are finishing.
 * - `exiting`: the process is ending.
 */
export type LifecyclePhase = 'starting' | 'running' | 'quitting' | 'finishing' | 'exiting'

/** The one main window, as the controller needs it. */
export interface MainWindowHost {
  /** `hidden`: exists but not shown (resident, or created and not shown yet). Minimized counts as shown. */
  state(): 'none' | 'hidden' | 'shown'
  /** Creates the window; resolves once it is shown. */
  open(): Promise<void>
  /** Shows, restores and focuses the existing window. */
  reveal(): void
  hide(): void
  /** Closes the front end at once (no close event). */
  destroy(): void
  send(request: LifecycleRequest): void
}

/**
 * Why a real quit started: `quit` from any quit entry, or `install` from 「安装并重启」. Cancelling the
 * quit, a save failure, or reopening while finishing drops the purpose with the quit.
 */
export type QuitPurpose = 'quit' | 'install'

/**
 * Why the process ends: the quit's purpose; `unsaved` when the user quit although drafts or the
 * workspace could not be saved; `session-end` once the system is ending the session. Only `install`,
 * and `quit` with automatic installation on, may install an update.
 */
export type ExitReason = QuitPurpose | 'unsaved' | 'session-end'

/** Sends that ended failed or unknown while finishing without a window. */
export interface FinishingSummary {
  failed: PublicationAttempt[]
  unknown: PublicationAttempt[]
}

export interface LifecycleDeps {
  window: MainWindowHost
  /** The remembered close choice; a read failure counts as `ask`. */
  closeAction(): Promise<CloseAction>
  publication: Pick<PublicationService, 'inFlight' | 'setUnattended' | 'abandon' | 'unstoredResults' | 'retryUnstored'>
  /** Stops window-independent background work (reads, downloads, checks) once finishing starts. */
  stopBackgroundWork(): void | Promise<void>
  /** Best-effort system notification; may be unavailable or throw. Launch notices are already stored. */
  notify(summary: FinishingSummary): void
  /** Ends the process (storage is closed on the way out); `reason` decides whether an update installs. */
  exit(reason: ExitReason): void
  /** Wall clock (epoch ms): send deadlines are recorded wall-clock times. */
  now(): number
  sleep(ms: number): Promise<void>
  onTrigger(trigger: LaunchTrigger): void
}

export interface Lifecycle {
  readonly phase: LifecyclePhase
  /** The current finishing/exiting quit left drafts or the workspace unsaved; cancelled or reopened quits do not count. */
  readonly unsaved: boolean
  /** Cold start: opens the first window, then reports `cold-start` once. */
  start(): Promise<void>
  /** The window's close button. */
  closeRequested(): Promise<void>
  /** 后台驻留 chosen in the renderer. */
  reside(): void
  /** Real quit from any entry (close choice, remembered choice, tray, app menu) or for installing an update. */
  requestQuit(purpose?: QuitPurpose): void
  presentQuit(): void
  cancelQuit(): void
  /** The renderer handled the editors and the workspace; `saved: false` when drafts or the workspace were not saved. */
  completeQuit(saved: boolean): void
  /** Explicit opening from the tray, the Dock or a second instance. */
  reopen(): void
  /** Notification clicks reveal/create a window without starting another check. */
  revealWithoutTrigger(): Promise<void>
  /**
   * The operating system is ending the session (shutdown, restart, log-off). From now on the process
   * never exits for installing; a running window is asked to save drafts and the workspace at once.
   */
  endSession(): void
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { window } = deps
  let phase: LifecyclePhase = 'starting'
  /** Bumped when a finishing ends (cancelled by reopening): its late timers and results are ignored. */
  let generation = 0
  let opening = false
  let openingTask: Promise<void> | null = null
  let purpose: QuitPurpose = 'quit'
  /** The running quit continues although drafts or the workspace were not saved. */
  let unsaved = false
  let sessionEnding = false

  /** `trigger`: an explicit opening to report; `null` when the app brings its window back itself. */
  async function openWindow(trigger: LaunchTrigger | null): Promise<void> {
    opening = true
    try {
      openingTask = window.open()
      await openingTask
    } finally {
      opening = false
      openingTask = null
    }
    if (phase === 'running' && trigger !== null) deps.onTrigger(trigger)
  }

  /** Leaves finishing without exiting: later results only update their records. */
  function stopFinishing(trigger: LaunchTrigger | null): void {
    generation++
    phase = 'running'
    purpose = 'quit'
    deps.publication.setUnattended(false)
    void openWindow(trigger)
  }

  async function finish(): Promise<void> {
    phase = 'finishing'
    const current = ++generation
    window.destroy()
    await deps.stopBackgroundWork()
    if (generation !== current || phase !== 'finishing') return
    deps.publication.setUnattended(true)
    const summary: FinishingSummary = { failed: [], unknown: [] }
    const record = (attempt: PublicationAttempt | null) => {
      if (attempt?.state === 'failed') summary.failed.push(attempt)
      if (attempt?.state === 'unknown') summary.unknown.push(attempt)
    }
    await Promise.all(
      deps.publication.inFlight().map(async (run) => {
        // Wait for the request only up to its original deadline; quitting never extends it.
        const settled = await Promise.race([
          run.done.then((attempt) => ({ attempt })),
          deps.sleep(Math.max(0, run.deadline - deps.now())).then(() => null)
        ])
        if (generation !== current) return
        record(settled !== null ? settled.attempt : await deps.publication.abandon(run.attempt.id))
      })
    )
    if (generation !== current || phase !== 'finishing') return
    // Results go to storage before a normal exit; one that cannot be stored keeps the app running
    // and brings the window back (with the workspace saved at this quit) to show it.
    if (deps.publication.unstoredResults().length > 0 && !(await deps.publication.retryUnstored())) {
      if (generation === current && phase === 'finishing') stopFinishing(null)
      return
    }
    if (generation !== current || phase !== 'finishing') return
    if (summary.failed.length + summary.unknown.length > 0) {
      try {
        deps.notify(summary)
      } catch {
        // The launch notice is stored with each result; a missing notification loses nothing.
      }
    }
    phase = 'exiting'
    deps.exit(sessionEnding ? 'session-end' : unsaved ? 'unsaved' : purpose)
  }

  function requestQuit(requested: QuitPurpose = 'quit'): void {
    if (phase === 'quitting') {
      if (requested === 'install') purpose = 'install'
      window.send({ kind: 'quit' })
      return
    }
    if (phase !== 'running') return
    phase = 'quitting'
    purpose = requested
    unsaved = false
    if (window.state() === 'none') void finish()
    else window.send({ kind: 'quit' })
  }

  return {
    get phase() {
      return phase
    },
    get unsaved() {
      return (phase === 'finishing' || phase === 'exiting') && unsaved
    },

    async start() {
      if (phase !== 'starting') return
      opening = true
      try {
        await window.open()
      } finally {
        opening = false
      }
      if (phase !== 'starting') return
      phase = 'running'
      deps.onTrigger('cold-start')
    },

    async closeRequested() {
      if (phase === 'quitting') {
        window.send({ kind: 'quit' })
        return
      }
      if (phase !== 'running') return
      const action = await deps.closeAction().catch((): CloseAction => 'ask')
      if (phase !== 'running') return
      if (action === 'background') window.hide()
      else if (action === 'quit') requestQuit()
      else window.send({ kind: 'close' })
    },

    reside() {
      if (phase === 'running') window.hide()
    },

    requestQuit,

    presentQuit() {
      if (phase === 'quitting' && window.state() !== 'none') window.reveal()
    },

    cancelQuit() {
      if (phase === 'quitting') {
        phase = 'running'
        purpose = 'quit'
      }
    },

    completeQuit(saved) {
      if (phase !== 'quitting') return
      unsaved = !saved
      void finish()
    },

    reopen() {
      if (phase === 'finishing') {
        // Opening again before the process ended: no exit; results now only update their records.
        stopFinishing('reopen')
        return
      }
      if (phase === 'quitting') {
        if (window.state() !== 'none') window.reveal()
        return
      }
      if (phase !== 'running' || opening) return
      const state = window.state()
      if (state === 'none') {
        void openWindow('reopen')
        return
      }
      window.reveal()
      if (state === 'hidden') deps.onTrigger('reopen')
    },
    async revealWithoutTrigger() {
      if (phase === 'exiting') return
      if (phase === 'finishing') {
        generation++
        phase = 'running'
        purpose = 'quit'
        deps.publication.setUnattended(false)
      }
      if (openingTask !== null) await openingTask
      else if (window.state() === 'none') await openWindow(null)
      window.reveal()
    },
    endSession() {
      sessionEnding = true
      if (phase === 'running' && window.state() !== 'none') window.send({ kind: 'session-end' })
    }
  }
}
