import { describe, expect, it } from 'vitest'
import { favoriteMarks } from '../../src/renderer/src/features/directory/Rail'

describe('favorite board marks on the rail', () => {
  it('shows the first character when no other favorite starts with it', () => {
    expect(favoriteMarks(['综合版1', '日记', '值班室'])).toEqual(['综', '日', '值'])
  })

  it('adds the second character when only the first characters collide', () => {
    expect(favoriteMarks(['技术宅', '技能交流', '综合版1'])).toEqual(['技术', '技能', '综'])
  })

  it('pairs the first character with the first one that differs when the first two collide too', () => {
    expect(favoriteMarks(['技术宅', '技术讨论'])).toEqual(['技宅', '技讨'])
  })

  it('takes the character after the longest prefix shared with any colliding favorite', () => {
    expect(favoriteMarks(['技术宅', '技能交流', '技术讨论'])).toEqual(['技宅', '技能', '技讨'])
  })

  it('keeps a name that is a prefix of another to its first two characters', () => {
    expect(favoriteMarks(['技术', '技术宅'])).toEqual(['技术', '技宅'])
  })

  it('ignores surrounding whitespace and keeps astral characters whole', () => {
    expect(favoriteMarks([' 𠮷野家 ', '𠮷野屋'])).toEqual(['𠮷家', '𠮷屋'])
  })
})
