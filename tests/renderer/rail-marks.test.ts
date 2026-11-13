import { describe, expect, it } from 'vitest'
import { boardMarkFrom, isBoardMark } from '../../src/shared/settings'
import { favoriteMarks, railMarks } from '../../src/renderer/src/features/directory/Rail'

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

  it("uses a favorite's own mark where set and the automatic one elsewhere", () => {
    const boards = [{ key: 'forum:1', label: '技术宅' }, { key: 'forum:2', label: '技术讨论' }]
    expect(railMarks(boards, { 'forum:2': 'TK' })).toEqual(['技宅', 'TK'])
  })

  it('keeps at most two characters of typed text, without spaces, emoji kept whole', () => {
    expect(boardMarkFrom(' 综 合版 ')).toBe('综合')
    expect(boardMarkFrom('👍🏽A!')).toBe('👍🏽A')
    expect(boardMarkFrom('   ')).toBe('')
  })

  it('drops invisible format characters but keeps joined emoji whole', () => {
    expect(boardMarkFrom('\u200B综\u202E合\u2066')).toBe('综合')
    expect(boardMarkFrom('\u200D\u0301A')).toBe('A')
    expect(boardMarkFrom('👨‍👩‍👧技术')).toBe('👨‍👩‍👧技')
  })

  it('accepts as a saved mark only what the field would keep', () => {
    for (const mark of ['综', '综合', '👍🏽A', '👨‍👩‍👧技']) expect(isBoardMark(mark)).toBe(true)
    for (const mark of ['', 'A B', ' 综', '三个字', '\u200B综', '综\u202E', '\u200D', '\n']) expect(isBoardMark(mark)).toBe(false)
  })
})
