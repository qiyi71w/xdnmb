import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { pausableCountdown } from '../../src/renderer/src/lib/pausableCountdown'

describe('pausable countdown (draft deletion notice)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const clock = () => Date.now()

  it('expires once, after the full duration of unheld time', () => {
    const onExpire = vi.fn()
    pausableCountdown(10_000, onExpire, { now: clock })
    vi.advanceTimersByTime(9_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('stands still while any reason holds it and resumes with the time it had left', () => {
    const onExpire = vi.fn()
    const countdown = pausableCountdown(10_000, onExpire, { now: clock })
    vi.advanceTimersByTime(4_000)
    countdown.hold('hover', true)
    countdown.hold('window', true)
    vi.advanceTimersByTime(60_000)
    // One reason released while another still holds: still standing.
    countdown.hold('hover', false)
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
    countdown.hold('window', false)
    // Repeated releases do not restart or double the timer.
    countdown.hold('window', false)
    vi.advanceTimersByTime(5_999)
    expect(onExpire).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onExpire).toHaveBeenCalledTimes(1)
  })

  it('starts held when created held, and never fires after dispose', () => {
    const onExpire = vi.fn()
    const countdown = pausableCountdown(10_000, onExpire, { held: ['busy'], now: clock })
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
    countdown.hold('busy', false)
    vi.advanceTimersByTime(9_000)
    // A failed undo: the notice stops expiring for good.
    countdown.dispose()
    countdown.hold('busy', false)
    vi.advanceTimersByTime(60_000)
    expect(onExpire).not.toHaveBeenCalled()
  })

  it('tolerates the expiry callback holding or disposing its own countdown', () => {
    let calls = 0
    const countdown = pausableCountdown(
      1_000,
      () => {
        calls += 1
        countdown.hold('focus', true)
        countdown.hold('focus', false)
        countdown.dispose()
      },
      { now: clock }
    )
    vi.advanceTimersByTime(10_000)
    expect(calls).toBe(1)
  })
})
