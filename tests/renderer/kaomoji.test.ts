import { describe, expect, it } from 'vitest'
import { newKaomoji, normalizeKaomojiText } from '../../src/renderer/src/features/editor/kaomoji'

describe('custom kaomoji', () => {
  it('turns pasted CRLF and CR line breaks into LF, so the text can be added', () => {
    const text = normalizeKaomojiText('第一行\r\n第二行\r第三行\n')
    expect(text).toBe('第一行\n第二行\n第三行\n')
    expect(newKaomoji([], text, '')).toEqual({ text })
    expect(newKaomoji([], '第一行\r\n第二行', '')).toBeNull()
  })

  it('trims the name, leaves a blank one out and refuses one past 16 characters', () => {
    expect(newKaomoji([], 'x', '  字符画  ')).toEqual({ text: 'x', name: '字符画' })
    expect(newKaomoji([], 'x', '   ')).toEqual({ text: 'x' })
    expect(newKaomoji([], 'x', '一二三四五六七八九十一二三四五六')).toEqual({ text: 'x', name: '一二三四五六七八九十一二三四五六' })
    expect(newKaomoji([], 'x', '一二三四五六七八九十一二三四五六七')).toBeNull()
  })

  it('compares by text only: names may repeat, texts may not', () => {
    const custom = [{ text: 'a', name: '同名' }]
    expect(newKaomoji(custom, 'b', '同名')).toEqual({ text: 'b', name: '同名' })
    expect(newKaomoji(custom, 'a', '别名')).toBeNull()
    expect(newKaomoji([], '[n]', '骰子')).toBeNull()
  })
})
