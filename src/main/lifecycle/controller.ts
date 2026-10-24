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
  stopBackgroundWork(): void
  /** Best-effort system notification; may be unavailable or throw. Launch notices are already stored. */
  notify(summary: FinishingSummary): void
  /** Ends the process (storage is closed on the way out). */
  exit(): void
  /** Wall clock (epoch ms): send deadlines are recorded wall-clock times. */
  now(): number
  sleep(ms: number): Promise<void>
  onTrigger(trigger: LaunchTrigger): void
}

export interface Lifecycle {
  readonly phase: LifecyclePhase
  /** Cold start: opens the first window, then reports `cold-start` once. */
  start(): Promise<void>
  /** The window's close button. */
  closeRequested(): Promise<void>
  /** 后台驻留 chosen in the renderer. */
  reside(): void
  /** Real quit from any entry (close choice, remembered choice, tray, app menu). */
  requestQuit(): void
  presentQuit(): void
  cancelQuit(): void
  completeQuit(): void
  /** Explicit opening from the tray, the Dock, a second instance or a system notification. */
  reopen(): void
}

export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  const { window } = deps
  let phase: LifecyclePhase = 'starting'
  /** Bumped when a finishing ends (cancelled by reopening): its late timers and results are ignored. */
  let generation = 0
  let opening = false

  /** `trigger`: an explicit opening to report; `null` when the app brings its window back itself. */
  async function openWindow(trigger: LaunchTrigger | null): Promise<void> {
    opening = true
    try {
      await window.open()
    } finally {
      opening = false
    }
    if (phase === 'running' && trigger !== null) deps.onTrigger(trigger)
  }

  /** Leaves finishing without exiting: later results only update their records. */
  function stopFinishing(trigger: LaunchTrigger | null): void {
    generation++
    phase = 'running'
    deps.publication.setUnattended(false)
    void openWindow(trigger)
  }

  async function finish(): Promise<void> {
    phase = 'finishing'
    const current = ++generation
    window.destroy()
    deps.stopBackgroundWork()
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
    deps.exit()
  }

  function requestQuit(): void {
    if (phase === 'quitting') {
      window.send({ kind: 'quit' })
      return
    }
    if (phase !== 'running') return
    phase = 'quitting'
    if (window.state() === 'none') void finish()
    else window.send({ kind: 'quit' })
  }

  return {
    get phase() {
      return phase
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
      if (phase === 'quitting') phase = 'running'
    },

    completeQuit() {
      if (phase === 'quitting') void finish()
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
    }
  }
}
