import { describe, expect, it } from 'vitest'
import { createReadingResets } from '../../src/renderer/src/features/content/readingResets'
import type { ThreadOpen } from '../../src/renderer/src/features/tabs/tabsState'
import { decideStart } from '../../src/renderer/src/features/thread/readingStart'

const anchor = { postId: '160', page: 3, offsetRatio: 0.65, viewportOffset: 40 }
const opened = (threadId: string, generation: number): ThreadOpen => ({
  threadId, head: null, target: null, snapshot: { mode: 'all', anchor, generation, temporaryOf: null, focus: null }, unlocatedPostId: null
})

describe('reading resets after a history clear', () => {
  it('advances only the threads storage reports cleared and voids only their navigation snapshots', () => {
    const resets = createReadingResets()
    const a = opened('100', resets.generation('100'))
    const b = opened('200', resets.generation('200'))
    const release = resets.block(null)
    expect(resets.writable('200', resets.generation('200'))).toBe(false)
    resets.reset(['100'])
    release()

    expect(decideStart(a, null, resets.generation('100'))).toEqual({ mode: 'all', position: { kind: 'top' } })
    expect(decideStart(b, null, resets.generation('200'))).toEqual({ mode: 'all', position: { kind: 'anchor', anchor } })
    expect(resets.writable('200', 0)).toBe(true)
    expect(resets.writable('100', 0)).toBe(false)
    // A snapshot taken by the fresh reader after the clear restores normally.
    expect(decideStart(opened('100', resets.generation('100')), null, resets.generation('100')).position).toEqual({ kind: 'anchor', anchor })
  })
})
