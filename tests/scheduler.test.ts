import { afterEach, describe, expect, it, vi } from 'vitest'
import { ReadCancelledError } from '../src/main/forum/contract'
import { createRequestScheduler } from '../src/main/reading/scheduler'

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, open: resolve }
}

afterEach(() => vi.useRealTimers())

describe('request scheduler', () => {
  it('lets a foreground read start while background work is queued, and never fills all slots with background', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 2, maxBackground: 1, backgroundSpacingMs: 0 })
    const started: string[] = []
    const background = gate()
    const signal = new AbortController().signal

    const bg1 = scheduler.run('background', signal, async () => {
      started.push('bg1')
      await background.promise
    })
    const bg2 = scheduler.run('background', signal, async () => {
      started.push('bg2')
    })
    const fg = scheduler.run('foreground', signal, async () => {
      started.push('fg')
    })

    await fg
    expect(started).toEqual(['bg1', 'fg'])
    background.open()
    await Promise.all([bg1, bg2])
    expect(started).toEqual(['bg1', 'fg', 'bg2'])
  })

  it('serves queued foreground work before queued background work', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 2, maxBackground: 1, backgroundSpacingMs: 0 })
    const order: string[] = []
    const blockers = [gate(), gate()]
    const signal = new AbortController().signal
    const running = blockers.map((blocker, index) =>
      scheduler.run('foreground', signal, async () => {
        order.push(`busy${index}`)
        await blocker.promise
      })
    )
    const bg = scheduler.run('background', signal, async () => {
      order.push('bg')
    })
    const fg = scheduler.run('foreground', signal, async () => {
      order.push('fg')
    })
    blockers[0]!.open()
    await fg
    blockers[1]!.open()
    await Promise.all([...running, bg])
    expect(order).toEqual(['busy0', 'busy1', 'fg', 'bg'])
  })

  it('cancelling a queued request removes it without running the work', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 1 })
    const blocker = gate()
    const free = new AbortController().signal
    const first = scheduler.run('foreground', free, () => blocker.promise)
    const controller = new AbortController()
    let ran = false
    const queued = scheduler.run('foreground', controller.signal, async () => {
      ran = true
    })
    controller.abort()
    await expect(queued).rejects.toBeInstanceOf(ReadCancelledError)
    blocker.open()
    await first
    expect(ran).toBe(false)
  })

  it('spaces background HTTP starts by a second without delaying foreground work', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const scheduler = createRequestScheduler({ monotonicNow: () => Date.now() })
    const starts: Array<{ lane: string; at: number }> = []
    const signal = new AbortController().signal
    await scheduler.run('background', signal, async () => { starts.push({ lane: 'background', at: Date.now() }) })
    const second = scheduler.run('background', signal, async () => { starts.push({ lane: 'background', at: Date.now() }) })
    const third = scheduler.run('background', signal, async () => { starts.push({ lane: 'background', at: Date.now() }) })
    await vi.advanceTimersByTimeAsync(999)
    await scheduler.run('foreground', signal, async () => { starts.push({ lane: 'foreground', at: Date.now() }) })
    expect(starts).toEqual([{ lane: 'background', at: 0 }, { lane: 'foreground', at: 999 }])
    await vi.advanceTimersByTimeAsync(1)
    await second
    await vi.advanceTimersByTimeAsync(1000)
    await third
    expect(starts).toEqual([
      { lane: 'background', at: 0 }, { lane: 'foreground', at: 999 },
      { lane: 'background', at: 1000 }, { lane: 'background', at: 2000 }
    ])
  })

  it('keeps background serialized even after the spacing timer has elapsed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const scheduler = createRequestScheduler({ maxConcurrent: 4, maxBackground: 4, monotonicNow: () => Date.now() })
    const blocker = gate()
    const signal = new AbortController().signal
    const starts: number[] = []
    const first = scheduler.run('background', signal, async () => { starts.push(Date.now()); await blocker.promise })
    const second = scheduler.run('background', signal, async () => { starts.push(Date.now()) })
    await vi.advanceTimersByTimeAsync(2000)
    expect(starts).toEqual([0])
    blocker.open()
    await Promise.all([first, second])
    expect(starts).toEqual([0, 2000])
  })

  it('cancels background work waiting for spacing without sending it later', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const scheduler = createRequestScheduler({ monotonicNow: () => Date.now() })
    await scheduler.run('background', new AbortController().signal, async () => {})
    const controller = new AbortController()
    let ran = false
    const queued = scheduler.run('background', controller.signal, async () => { ran = true })
    const rejection = expect(queued).rejects.toBeInstanceOf(ReadCancelledError)
    controller.abort()
    await rejection
    await vi.advanceTimersByTimeAsync(2000)
    expect(ran).toBe(false)
  })
})
