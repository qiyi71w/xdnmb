import { describe, expect, it } from 'vitest'
import type { CloseAction, LifecycleRequest } from '../src/shared/lifecycle'
import type { PublicationAttempt, PublicationState } from '../src/shared/publication'
import { createLifecycle, type FinishingSummary, type LaunchTrigger } from '../src/main/lifecycle/controller'
import type { InFlightPublication } from '../src/main/publication/service'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => (resolve = done))
  return { promise, resolve }
}

/** Lets settled promise chains run; all deadlines are driven by the injected clock and sleeps. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve))

function sendAttempt(id: string, state: PublicationState, createdAt: string): PublicationAttempt {
  return {
    id, requestId: `request-${id}`, editorId: `editor-${id}`, draftId: null, state, problem: state === 'confirmed' ? null : 'network',
    payload: { draftId: null, target: { kind: 'reply', threadId: '100' }, credentialId: '1',
      fields: { content: '正文', title: '', name: '', email: '', watermark: false }, attachmentId: null },
    createdAt, updatedAt: createdAt, postId: null, threadId: null, savedDraftId: null
  }
}

/** Controlled window, clock, timers, notification and in-flight sends around the real controller. */
function setup(options: { closeAction?: CloseAction | 'unreadable'; notify?: (summary: FinishingSummary) => void } = {}) {
  let windowState: 'none' | 'hidden' | 'shown' = 'none'
  let pendingOpen: ReturnType<typeof deferred<void>> | null = null
  const sent: LifecycleRequest[] = []
  const triggers: LaunchTrigger[] = []
  const sleeps: Array<{ ms: number; resolve: () => void }> = []
  const notified: FinishingSummary[] = []
  const unattended: boolean[] = []
  const abandoned: string[] = []
  /** Results the fake service could not store; `storageUp` decides whether a retry stores them. */
  const unstored: PublicationAttempt[] = []
  let storageUp = true
  let opens = 0
  let exits = 0
  let stops = 0
  let clock = Date.parse('2026-10-24T08:00:00.000Z')
  const runs: InFlightPublication[] = []
  const closeAction = options.closeAction ?? 'ask'

  const lifecycle = createLifecycle({
    window: {
      state: () => windowState,
      open() {
        opens++
        windowState = 'hidden'
        pendingOpen = deferred<void>()
        return pendingOpen.promise.then(() => {
          windowState = 'shown'
        })
      },
      reveal: () => {
        windowState = 'shown'
      },
      hide: () => {
        windowState = 'hidden'
      },
      destroy: () => {
        windowState = 'none'
      },
      send: (request) => sent.push(request)
    },
    closeAction: async () => {
      if (closeAction === 'unreadable') throw new Error('storage')
      return closeAction
    },
    publication: {
      inFlight: () => runs,
      setUnattended: (on) => unattended.push(on),
      async abandon(id) {
        abandoned.push(id)
        return sendAttempt(id, 'unknown', new Date(clock).toISOString())
      },
      unstoredResults: () => [...unstored],
      async retryUnstored() {
        if (storageUp) unstored.length = 0
        return unstored.length === 0
      }
    },
    stopBackgroundWork: () => { stops++ },
    notify(summary) {
      notified.push(summary)
      options.notify?.(summary)
    },
    exit: () => exits++,
    now: () => clock,
    sleep: (ms) => new Promise<void>((resolve) => sleeps.push({ ms, resolve })),
    onTrigger: (trigger) => triggers.push(trigger)
  })

  return {
    lifecycle, sent, triggers, sleeps, notified, unattended, abandoned, runs, unstored,
    setStorageUp(up: boolean) { storageUp = up },
    get windowState() { return windowState },
    get opens() { return opens },
    get exits() { return exits },
    get stops() { return stops },
    advance(ms: number) { clock += ms },
    now: () => clock,
    async showWindow() {
      pendingOpen?.resolve()
      await flush()
    },
    async started() {
      const start = lifecycle.start()
      await this.showWindow()
      await start
    }
  }
}

describe('window lifecycle', () => {
  it('reports one cold start however many launch events arrive, and a reopen only when the hidden window is opened explicitly', async () => {
    const s = setup({ closeAction: 'background' })
    const start = s.lifecycle.start()
    // macOS sends activate during launch; the window is not shown yet.
    s.lifecycle.reopen()
    await s.showWindow()
    await start
    s.lifecycle.reopen()
    expect(s.triggers).toEqual(['cold-start'])
    expect(s.opens).toBe(1)

    await s.lifecycle.closeRequested()
    expect(s.windowState).toBe('hidden')
    expect(s.triggers).toEqual(['cold-start'])
    s.lifecycle.reopen()
    s.lifecycle.reopen()
    expect(s.windowState).toBe('shown')
    expect(s.triggers).toEqual(['cold-start', 'reopen'])
  })

  it('reveals a resident window on notification click without emitting a check trigger', async () => {
    const s = setup({ closeAction: 'background' })
    await s.started()
    await s.lifecycle.closeRequested()
    await s.lifecycle.revealWithoutTrigger()
    expect(s.windowState).toBe('shown')
    expect(s.triggers).toEqual(['cold-start'])
    expect(s.opens).toBe(1)
  })

  it('creates a destroyed finishing window on notification click and does not trigger a reopen check', async () => {
    const s = setup()
    await s.started()
    const result = deferred<PublicationAttempt | null>()
    s.runs.push({ attempt: sendAttempt('notice', 'sending', new Date(s.now()).toISOString()), deadline: s.now() + 60_000, done: result.promise })
    s.lifecycle.requestQuit()
    s.lifecycle.completeQuit()
    await flush()
    const reveal = s.lifecycle.revealWithoutTrigger()
    await s.showWindow()
    await reveal
    expect(s.windowState).toBe('shown')
    expect(s.lifecycle.phase).toBe('running')
    expect(s.triggers).toEqual(['cold-start'])
    result.resolve(sendAttempt('notice', 'confirmed', new Date(s.now()).toISOString()))
    await flush()
    expect(s.exits).toBe(0)
  })

  it('asks when no choice is remembered or it cannot be read, and quits through the renderer when quit is remembered', async () => {
    const asking = setup({ closeAction: 'unreadable' })
    await asking.started()
    await asking.lifecycle.closeRequested()
    expect(asking.sent).toEqual([{ kind: 'close' }])
    asking.lifecycle.reside()
    expect(asking.windowState).toBe('hidden')

    const quitting = setup({ closeAction: 'quit' })
    await quitting.started()
    await quitting.lifecycle.closeRequested()
    // Pressed again while the renderer still handles it: asked again, never a second flow.
    await quitting.lifecycle.closeRequested()
    expect(quitting.sent).toEqual([{ kind: 'quit' }, { kind: 'quit' }])
    expect(quitting.lifecycle.phase).toBe('quitting')
    quitting.lifecycle.cancelQuit()
    expect(quitting.lifecycle.phase).toBe('running')
    expect(quitting.exits).toBe(0)
    expect(quitting.windowState).toBe('shown')
  })

  it('waits for a started send only until its original deadline, records it as unknown, notifies and exits', async () => {
    const s = setup()
    await s.started()
    const createdAt = s.now()
    const run = deferred<PublicationAttempt | null>()
    s.runs.push({ attempt: sendAttempt('7', 'sending', new Date(createdAt).toISOString()), deadline: createdAt + 60_000, done: run.promise })
    s.advance(45_000)
    s.lifecycle.requestQuit()
    s.lifecycle.completeQuit()
    await flush()

    expect(s.windowState).toBe('none')
    expect(s.stops).toBe(1)
    expect(s.unattended).toEqual([true])
    // The quit came 45 s after the intent: only the remaining 15 s are waited, never a new 60 s.
    expect(s.sleeps.map((sleep) => sleep.ms)).toEqual([15_000])
    expect(s.exits).toBe(0)

    s.advance(15_000)
    s.sleeps[0]!.resolve()
    await flush()
    expect(s.abandoned).toEqual(['7'])
    expect(s.notified).toMatchObject([{ failed: [], unknown: [{ id: '7', state: 'unknown' }] }])
    expect(s.exits).toBe(1)
    expect(s.lifecycle.phase).toBe('exiting')
  })

  it('exits as soon as started sends end, also when the system notification fails', async () => {
    const s = setup({ notify: () => { throw new Error('notifications unavailable') } })
    await s.started()
    const run = deferred<PublicationAttempt | null>()
    s.runs.push({ attempt: sendAttempt('8', 'sending', new Date(s.now()).toISOString()), deadline: s.now() + 60_000, done: run.promise })
    s.lifecycle.requestQuit()
    s.lifecycle.completeQuit()
    await flush()
    run.resolve(sendAttempt('8', 'failed', new Date(s.now()).toISOString()))
    await flush()
    expect(s.abandoned).toEqual([])
    expect(s.notified).toMatchObject([{ failed: [{ id: '8' }], unknown: [] }])
    expect(s.exits).toBe(1)
  })

  it('cancels the exit when the app is opened again while finishing; the send then only updates its result', async () => {
    const s = setup()
    await s.started()
    const run = deferred<PublicationAttempt | null>()
    s.runs.push({ attempt: sendAttempt('9', 'sending', new Date(s.now()).toISOString()), deadline: s.now() + 60_000, done: run.promise })
    s.lifecycle.requestQuit()
    s.lifecycle.completeQuit()
    await flush()
    expect(s.windowState).toBe('none')

    s.lifecycle.reopen()
    expect(s.lifecycle.phase).toBe('running')
    expect(s.unattended).toEqual([true, false])
    await s.showWindow()
    expect(s.opens).toBe(2)
    expect(s.triggers).toEqual(['cold-start', 'reopen'])

    s.advance(60_000)
    s.sleeps[0]!.resolve()
    run.resolve(sendAttempt('9', 'confirmed', new Date(s.now()).toISOString()))
    await flush()
    expect(s.abandoned).toEqual([])
    expect(s.notified).toEqual([])
    expect(s.exits).toBe(0)
    expect(s.windowState).toBe('shown')
  })

  it('does not exit while a result could not be stored: the window comes back, and a later quit exits once it is stored', async () => {
    const s = setup()
    await s.started()
    const run = deferred<PublicationAttempt | null>()
    s.runs.push({ attempt: sendAttempt('10', 'sending', new Date(s.now()).toISOString()), deadline: s.now() + 60_000, done: run.promise })
    s.lifecycle.requestQuit()
    s.lifecycle.completeQuit()
    await flush()
    s.setStorageUp(false)
    s.unstored.push(sendAttempt('10', 'confirmed', new Date(s.now()).toISOString()))
    run.resolve(null)
    await flush()
    expect(s.exits).toBe(0)
    expect(s.lifecycle.phase).toBe('running')
    expect(s.unattended).toEqual([true, false])
    expect(s.opens).toBe(2)
    await s.showWindow()
    // The app brought its window back by itself: not an explicit reopen.
    expect(s.triggers).toEqual(['cold-start'])
    expect(s.notified).toEqual([])

    s.runs.length = 0
    s.setStorageUp(true)
    s.lifecycle.requestQuit()
    s.lifecycle.completeQuit()
    await flush()
    expect(s.unstored).toEqual([])
    expect(s.exits).toBe(1)
  })

  it('exits at once when nothing was being sent', async () => {
    const s = setup()
    await s.started()
    s.lifecycle.requestQuit()
    s.lifecycle.completeQuit()
    await flush()
    expect(s.sleeps).toEqual([])
    expect(s.notified).toEqual([])
    expect(s.exits).toBe(1)
  })
})
