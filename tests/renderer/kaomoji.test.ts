import { describe, expect, it } from 'vitest'
import { KAOMOJI_PRESETS, newKaomoji, normalizeKaomojiText, recentKaomojiItems, withRecentKaomoji } from '../../src/renderer/src/features/editor/kaomoji'
import { KAOMOJI_DECOR } from '../../src/renderer/src/lib/kaomojiDecor'

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

describe('recent kaomoji', () => {
  it('puts the inserted kaomoji first, once, and keeps at most 8', () => {
    expect(withRecentKaomoji([], 'a')).toEqual(['a'])
    expect(withRecentKaomoji(['a', 'b', 'c'], 'c')).toEqual(['c', 'a', 'b'])
    expect(withRecentKaomoji(['a', 'b', 'c'], 'a')).toEqual(['a', 'b', 'c'])
    expect(withRecentKaomoji(['1', '2', '3', '4', '5', '6', '7', '8'], '9')).toEqual(['9', '1', '2', '3', '4', '5', '6', '7'])
  })

  it('shows presets and own kaomoji with the names they have elsewhere in the panel', () => {
    const custom = [{ text: '多行\n颜文字', name: '多行' }, { text: 'mine' }]
    expect(recentKaomojiItems(['[n]', '多行\n颜文字', '|∀ﾟ', 'mine'], custom)).toEqual([
      { text: '[n]', name: '骰子' },
      { text: '多行\n颜文字', name: '多行' },
      { text: '|∀ﾟ', name: null },
      { text: 'mine', name: null }
    ])
  })

  it('leaves out an own kaomoji once it is deleted', () => {
    expect(recentKaomojiItems(['mine', '[n]'], [{ text: 'mine' }]).map((item) => item.text)).toEqual(['mine', '[n]'])
    expect(recentKaomojiItems(['mine', '[n]'], []).map((item) => item.text)).toEqual(['[n]'])
  })
})

describe('decorative kaomoji', () => {
  it('come from the presets', () => {
    const presets = new Set(KAOMOJI_PRESETS.map((preset) => preset.text))
    expect(Object.values(KAOMOJI_DECOR).filter((text) => !presets.has(text))).toEqual([])
  })
})
