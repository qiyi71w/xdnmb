import { describe, expect, it } from 'vitest'
import { singleFlight } from '../../src/renderer/src/lib/singleFlight'

describe('single-flight busy guard (page actions)', () => {
  it('refuses a second press made before the first action settles, in the same tick', async () => {
    const flight = singleFlight()
    const { promise, resolve } = Promise.withResolvers<string>()
    let calls = 0
    const action = () => {
      calls += 1
      return promise
    }
    const first = flight.run(action)
    // Two presses in one task, before any re-render: only the first runs.
    const second = flight.run(action)
    expect(calls).toBe(1)
    expect(flight.running).toBe(true)
    resolve('done')
    expect(await first).toBe('done')
    expect(await second).toBeUndefined()
    expect(flight.running).toBe(false)
  })

  it('runs again once the earlier action settled, failures included', async () => {
    const flight = singleFlight()
    await expect(flight.run(() => Promise.reject(new Error('storage')))).rejects.toThrow('storage')
    expect(flight.running).toBe(false)
    expect(await flight.run(() => Promise.resolve(2))).toBe(2)
  })
})
