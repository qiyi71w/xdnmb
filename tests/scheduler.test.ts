import { describe, expect, it } from 'vitest'
import { ReadCancelledError } from '../src/main/forum/contract'
import { createRequestScheduler } from '../src/main/reading/scheduler'

function gate() {
  const { promise, resolve } = Promise.withResolvers<void>()
  return { promise, open: resolve }
}

describe('request scheduler', () => {
  it('lets a foreground read start while background work is queued, and never fills all slots with background', async () => {
    const scheduler = createRequestScheduler({ maxConcurrent: 2, maxBackground: 1 })
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
    const scheduler = createRequestScheduler({ maxConcurrent: 2, maxBackground: 1 })
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
})
