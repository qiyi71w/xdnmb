import { describe, expect, it } from 'vitest'
import { moveItem, moveKey, slotAt, slotIndex } from '../../src/renderer/src/lib/reorder'

const list = ['a', 'b', 'c', 'd'] as const

describe('moving an item to an index', () => {
  it('moves to the first and the last place, keeping the others in order', () => {
    expect(moveItem(list, 2, 0)).toEqual(['c', 'a', 'b', 'd'])
    expect(moveItem(list, 1, 3)).toEqual(['a', 'c', 'd', 'b'])
    expect(moveItem(list, 3, 0)).toEqual(['d', 'a', 'b', 'c'])
    expect(moveItem(list, 0, 3)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('moves one place up or down', () => {
    expect(moveItem(list, 1, 0)).toEqual(['b', 'a', 'c', 'd'])
    expect(moveItem(list, 1, 2)).toEqual(['a', 'c', 'b', 'd'])
  })

  it('reports no move at the same place and leaves the input alone', () => {
    expect(moveItem(list, 2, 2)).toBeNull()
    expect(list).toEqual(['a', 'b', 'c', 'd'])
  })

  it('reports no move for an index outside the list (past either end, fractional)', () => {
    expect(moveItem(list, 0, -1)).toBeNull()
    expect(moveItem(list, 3, 4)).toBeNull()
    expect(moveItem(list, -1, 0)).toBeNull()
    expect(moveItem(list, 4, 0)).toBeNull()
    expect(moveItem(list, 1.5, 0)).toBeNull()
    expect(moveItem([], 0, 0)).toBeNull()
  })
})

describe('moving a key into another key’s place', () => {
  it('takes the target’s place in either direction', () => {
    expect(moveKey(list, 'a', 'c')).toEqual(['b', 'c', 'a', 'd'])
    expect(moveKey(list, 'd', 'b')).toEqual(['a', 'd', 'b', 'c'])
  })

  it('keeps that place when the shown list skips items of the stored one', () => {
    // Shown: a, c, d (b is not shown). Moving d onto c's shown place keeps it before c when stored.
    expect(moveKey(['a', 'b', 'c', 'd'], 'd', 'c')).toEqual(['a', 'b', 'd', 'c'])
  })

  it('reports no move for the same key or a missing one', () => {
    expect(moveKey(list, 'b', 'b')).toBeNull()
    expect(moveKey<string>(list, 'x', 'a')).toBeNull()
    expect(moveKey<string>(list, 'a', 'x')).toBeNull()
  })
})

describe('drop slots', () => {
  const middles = [10, 30, 50]

  it('maps a pointer y to the gap before the first item whose middle is below it', () => {
    expect(slotAt(middles, 0)).toBe(0)
    expect(slotAt(middles, 9.9)).toBe(0)
    expect(slotAt(middles, 10)).toBe(1)
    expect(slotAt(middles, 31)).toBe(2)
    expect(slotAt(middles, 50)).toBe(3)
    expect(slotAt(middles, 999)).toBe(3)
    expect(slotAt([], 5)).toBe(0)
  })

  it('maps a slot to the index the dragged item ends at', () => {
    expect(slotIndex(2, 0, 4)).toBe(0)
    expect(slotIndex(0, 4, 4)).toBe(3)
    expect(slotIndex(1, 3, 4)).toBe(2)
    expect(slotIndex(3, 1, 4)).toBe(1)
  })

  it('reports no move for the gaps right around the dragged item', () => {
    expect(slotIndex(1, 1, 4)).toBeNull()
    expect(slotIndex(1, 2, 4)).toBeNull()
    expect(slotIndex(0, 0, 4)).toBeNull()
    expect(slotIndex(3, 4, 4)).toBeNull()
  })

  it('reports no move outside the list', () => {
    expect(slotIndex(0, -1, 4)).toBeNull()
    expect(slotIndex(0, 5, 4)).toBeNull()
    expect(slotIndex(4, 0, 4)).toBeNull()
    expect(slotIndex(-1, 0, 4)).toBeNull()
  })
})
