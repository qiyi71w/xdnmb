import { describe, expect, it } from 'vitest'
import { captureAnchor, scrollTopForAnchor, type PostBox } from '../../src/renderer/src/features/reading/anchor'

const boxes: PostBox[] = [
  { postId: '1', page: 1, top: 0, height: 300 },
  { postId: '2', page: 1, top: 320, height: 600 },
  { postId: '3', page: 2, top: 940, height: 200 }
]

describe('reading anchor', () => {
  it('keeps the reading line on the same place of the same post when content above grows', () => {
    const anchor = captureAnchor(boxes, 400, 70)
    expect(anchor).toEqual({ postId: '2', page: 1, offsetRatio: 0.25, viewportOffset: 70 })
    // A late image adds 400px to post 1: post 2 moves down, the reader must follow it.
    const grown = { top: 720, height: 600 }
    const scrollTop = scrollTopForAnchor(anchor!, grown)
    expect(scrollTop).toBe(800)
    expect(captureAnchor([{ ...boxes[0]!, height: 700 }, { ...boxes[1]!, ...grown }], scrollTop, 70)).toEqual(anchor)
  })

  it('uses the next post when the reading line falls between posts', () => {
    expect(captureAnchor(boxes, 240, 70)).toMatchObject({ postId: '2', offsetRatio: 0 })
    expect(captureAnchor(boxes, 5000, 70)).toMatchObject({ postId: '3', offsetRatio: 1 })
    expect(captureAnchor([], 0, 70)).toBeNull()
  })
})
