import { describe, expect, it } from 'vitest'
import { MAX_MARK_READ_IDS } from '../../src/shared/api'
import type { PostId } from '../../src/shared/forum'
import { createReadingResets } from '../../src/renderer/src/features/content/readingResets'
import type { ThreadOpen } from '../../src/renderer/src/features/tabs/tabsState'
import { decideStart, markAllInChunks } from '../../src/renderer/src/features/thread/readingStart'

const anchor = { postId: '160', page: 3, offsetRatio: 0.65, viewportOffset: 40 }
const opened = (threadId: string, generation: number): ThreadOpen => ({
  threadId, head: null, target: null, snapshot: { mode: 'all', anchor, generation }
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

  it('stops a pending 全部标为已读 batch once a clear blocks or resets the thread', async () => {
    const resets = createReadingResets()
    const at = resets.generation('100')
    const postIds: PostId[] = Array.from({ length: MAX_MARK_READ_IDS * 2 + 1 }, (_, index) => String(1000 + index))
    const sent: PostId[][] = []
    let release = (): void => undefined
    const result = await markAllInChunks(postIds, () => resets.writable('100', at), async (chunk) => {
      sent.push(chunk)
      // The clear starts and succeeds while the first chunk is in flight.
      release = resets.block('100')
      resets.reset(['100'])
      return true
    })
    release()

    expect(sent).toHaveLength(1)
    expect(result).toEqual({ failed: false, stopped: true })
    const fresh = resets.generation('100')
    const next = await markAllInChunks(['1'], () => resets.writable('100', fresh), async () => true)
    expect(next).toEqual({ failed: false, stopped: false })
  })
})
