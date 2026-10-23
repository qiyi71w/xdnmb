import { describe, expect, it } from 'vitest'
import { qualifiesAsVisible, ReadJudge, type JudgeClock, type PostVisibility } from '../../src/renderer/src/features/reading/readJudge'

/** Deterministic clock: timers fire only when the test advances time. */
function controlledClock() {
  let now = 0
  let timers: { at: number; callback: () => void; handle: number }[] = []
  let nextHandle = 1
  const clock: JudgeClock = {
    now: () => now,
    setTimeout(callback, ms) {
      const handle = nextHandle++
      timers.push({ at: now + ms, callback, handle })
      return handle
    },
    clearTimeout(handle) {
      timers = timers.filter((timer) => timer.handle !== handle)
    }
  }
  const advance = (ms: number) => {
    const target = now + ms
    for (;;) {
      const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at)[0]
      if (due === undefined) break
      timers = timers.filter((timer) => timer !== due)
      now = due.at
      due.callback()
    }
    now = target
  }
  return { clock, advance }
}

function setup() {
  const { clock, advance } = controlledClock()
  const read: string[][] = []
  const judge = new ReadJudge({ clock, onRead: (ids) => read.push(ids) })
  judge.setActive(true)
  return { judge, advance, read }
}

const VIEWPORT = 800
const visible = (postId: string, visibleHeight: number, postHeight = 200): PostVisibility => ({ postId, postHeight, visibleHeight })

describe('visibility threshold', () => {
  it('requires half of the smaller of the post height and the viewport height', () => {
    expect(qualifiesAsVisible(visible('1', 49, 100), VIEWPORT)).toBe(false)
    expect(qualifiesAsVisible(visible('1', 50, 100), VIEWPORT)).toBe(true)
    expect(qualifiesAsVisible(visible('2', 399, 3000), VIEWPORT)).toBe(false)
    expect(qualifiesAsVisible(visible('2', 400, 3000), VIEWPORT)).toBe(true)
    expect(qualifiesAsVisible(visible('3', 0, 0), VIEWPORT)).toBe(false)
  })
})

describe('ReadJudge dwell', () => {
  it('reports a post once after it qualifies continuously for 500ms', () => {
    const { judge, advance, read } = setup()
    judge.observe([visible('1', 200)], VIEWPORT)
    advance(499)
    expect(read).toEqual([])
    advance(1)
    expect(read).toEqual([['1']])
    judge.observe([visible('1', 200)], VIEWPORT)
    advance(2000)
    expect(read).toEqual([['1']])
  })

  it('does not report a post that is scrolled past before 500ms, and restarts the dwell when it returns', () => {
    const { judge, advance, read } = setup()
    judge.observe([visible('1', 200)], VIEWPORT)
    advance(300)
    judge.observe([visible('1', 90), visible('2', 200)], VIEWPORT)
    advance(300)
    expect(read).toEqual([])
    judge.observe([visible('1', 200), visible('2', 200)], VIEWPORT)
    advance(200)
    expect(read).toEqual([['2']])
    advance(300)
    expect(read).toEqual([['2'], ['1']])
  })

  it('accumulates nothing while inactive (background tab, hidden reader) and restarts when active again', () => {
    const { judge, advance, read } = setup()
    judge.observe([visible('1', 200)], VIEWPORT)
    advance(400)
    judge.setActive(false)
    judge.observe([visible('1', 200)], VIEWPORT)
    advance(1000)
    expect(read).toEqual([])
    judge.setActive(true)
    judge.observe([visible('1', 200)], VIEWPORT)
    advance(499)
    expect(read).toEqual([])
    advance(1)
    expect(read).toEqual([['1']])
  })

  it('never reports posts already known to be read, and stops after dispose', () => {
    const { judge, advance, read } = setup()
    judge.markKnownRead(['1'])
    judge.observe([visible('1', 200), visible('2', 200)], VIEWPORT)
    advance(250)
    judge.dispose()
    advance(1000)
    expect(read).toEqual([])
  })
})
