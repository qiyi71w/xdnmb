import { describe, expect, it } from 'vitest'
import { PILL_REST, scrollStep, type PillEnds, type PillTracker } from '../../src/renderer/src/features/thread/jumpPillModel'

const VIEWPORT = 900
const AWAY: PillEnds = { atStart: false, atEnd: false }

/** One scroll made by the user's own input. */
function step(state: PillTracker, delta: number, ends: PillEnds = AWAY): PillTracker {
  return scrollStep(state, { delta, viewport: VIEWPORT, byGesture: true }, ends)
}

/** Applies user scrolls of the given deltas in order. */
function scroll(deltas: number[], ends: PillEnds = AWAY, from: PillTracker = PILL_REST): PillTracker {
  return deltas.reduce((state, delta) => step(state, delta, ends), from)
}

describe('floating 开头 / 末尾 pills', () => {
  it('show only after about a third of the viewport in one direction', () => {
    expect(scroll([100, 100]).shown).toBeNull()
    expect(scroll([100, 100, 100]).shown).toBe('end')
    expect(scroll([-150, -149]).shown).toBeNull()
    expect(scroll([-150, -150]).shown).toBe('start')
  })

  it('show one at a time: turning around hides the shown pill and starts a new run', () => {
    const down = scroll([400])
    expect(down.shown).toBe('end')
    const turned = step(down, -10)
    expect(turned).toEqual({ direction: 'up', travelled: 10, shown: null })
    expect(scroll([-300], AWAY, turned).shown).toBe('start')
  })

  it('stay hidden for an end already on screen', () => {
    expect(scroll([-400], { atStart: true, atEnd: false }).shown).toBeNull()
    expect(scroll([400], { atStart: false, atEnd: true }).shown).toBeNull()
    // Reaching the end while its pill shows hides it.
    expect(step(scroll([400]), 50, { atStart: false, atEnd: true }).shown).toBeNull()
  })

  it('ignore a step that did not move', () => {
    const shown = scroll([400])
    expect(step(shown, 0)).toBe(shown)
  })

  it('never show for scrolls without the user input, such as a thread opening and settling', () => {
    // Late layout after opening moves the reader down by more than a viewport: no pill.
    const settled = scrollStep(PILL_REST, { delta: 1200, viewport: VIEWPORT, byGesture: false }, AWAY)
    expect(settled).toBe(PILL_REST)
    // Nor does such a scroll extend or break a run the user is making.
    const run = scroll([200])
    expect(scrollStep(run, { delta: 400, viewport: VIEWPORT, byGesture: false }, AWAY)).toBe(run)
    expect(scrollStep(run, { delta: -400, viewport: VIEWPORT, byGesture: false }, AWAY)).toBe(run)
  })
})
