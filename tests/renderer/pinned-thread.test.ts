import { describe, expect, it } from 'vitest'
import { isPinnedThread } from '../../src/renderer/src/features/feed/pinned'

function thread(createdAt: string | null, isAdmin: boolean | null = false) {
  return { head: { createdAt, isAdmin } }
}

// The No.52752005 shape: an admin thread from 2022 heading a page of current threads.
const PINNED = thread('2022-10-16(日)23:14:27', true)
const RECENT = thread('2026-10-26(一)13:12:00')

describe('isPinnedThread', () => {
  it('holds for an admin thread heading page 1 at least 30 days before the second', () => {
    expect(isPinnedThread(1, [PINNED, RECENT, thread('2026-10-26(一)13:00:00')])).toBe(true)
    // Exactly 30 days is enough.
    expect(isPinnedThread(1, [thread('2026-09-26(六)13:12:00', true), RECENT])).toBe(true)
  })

  it('is false when the first thread is less than 30 days older', () => {
    expect(isPinnedThread(1, [thread('2026-09-27(日)13:12:00', true), RECENT])).toBe(false)
    // One second short of 30 days.
    expect(isPinnedThread(1, [thread('2026-09-26(六)13:12:01', true), RECENT])).toBe(false)
  })

  it('compares in forum time across the weekday-free form too', () => {
    expect(isPinnedThread(1, [thread('2026-09-26 13:12:00', true), RECENT])).toBe(true)
  })

  it('is false for a first thread not posted by an admin, or with unknown admin status', () => {
    expect(isPinnedThread(1, [thread('2022-10-16(日)23:14:27', false), RECENT])).toBe(false)
    expect(isPinnedThread(1, [thread('2022-10-16(日)23:14:27', null), RECENT])).toBe(false)
  })

  it('is false on any page other than 1', () => {
    expect(isPinnedThread(2, [PINNED, RECENT])).toBe(false)
  })

  it('is false when the page has fewer than two threads', () => {
    expect(isPinnedThread(1, [PINNED])).toBe(false)
    expect(isPinnedThread(1, [])).toBe(false)
  })

  it('is false when either time cannot be parsed', () => {
    expect(isPinnedThread(1, [thread('2022-10-16', true), RECENT])).toBe(false)
    expect(isPinnedThread(1, [thread(null, true), RECENT])).toBe(false)
    expect(isPinnedThread(1, [PINNED, thread('刚刚')])).toBe(false)
    expect(isPinnedThread(1, [PINNED, thread(null)])).toBe(false)
  })
})
