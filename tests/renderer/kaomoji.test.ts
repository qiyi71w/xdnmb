import { describe, expect, it } from 'vitest'
import {
  KAOMOJI_PRESETS, kaomojiInsertion, newKaomoji, normalizeKaomojiText, recentKaomojiItems, withRecentKaomoji
} from '../../src/renderer/src/features/editor/kaomoji'
import { KAOMOJI_DECOR } from '../../src/renderer/src/lib/kaomojiDecor'

const preset = (name: string) => {
  const found = KAOMOJI_PRESETS.find((item) => item.name === name)
  if (found === undefined) throw new Error(`no preset named ${name}`)
  return found
}

describe('kaomoji presets', () => {
  it('repeat no name and no text: the panel keys them by name, 最近使用 knows them by text', () => {
    const repeated = (values: string[]) => values.filter((value, index) => values.indexOf(value) !== index)
    expect(repeated(KAOMOJI_PRESETS.map((item) => item.name))).toEqual([])
    expect(repeated(KAOMOJI_PRESETS.map((item) => item.text))).toEqual([])
  })

  it('are the official 100, the 49 蓝岛 ones, then 防剧透, 骰子, 高级骰子 and 全角空格', () => {
    expect(KAOMOJI_PRESETS).toHaveLength(153)
    expect(KAOMOJI_PRESETS[99]?.name).toBe('大嘘')
    expect(KAOMOJI_PRESETS[100]?.name).toBe('( ´_ゝ`)旦')
    expect(KAOMOJI_PRESETS[148]?.name).toBe('巴拉巴拉')
    expect(KAOMOJI_PRESETS.slice(149)).toEqual([
      { name: '防剧透', text: '[h][/h]', wrap: { prefix: '[h]', suffix: '[/h]' } },
      { name: '骰子', text: '[n]' },
      { name: '高级骰子', text: '[n,m]' },
      { name: '全角空格', text: '\u3000' }
    ])
  })
})

describe('inserting a kaomoji', () => {
  it('replaces the selection, the caret after the insertion', () => {
    expect(kaomojiInsertion('前后', 1, 1, preset('骰子'))).toEqual({ replacement: '[n]', text: '前[n]后', caret: 4 })
    expect(kaomojiInsertion('前选中后', 1, 3, preset('骰子'))).toEqual({ replacement: '[n]', text: '前[n]后', caret: 4 })
    expect(kaomojiInsertion('前选中后', 1, 3, { text: 'mine' })).toEqual({ replacement: 'mine', text: '前mine后', caret: 5 })
  })

  it('防剧透 with nothing selected inserts both tags, the caret between them', () => {
    expect(kaomojiInsertion('', 0, 0, preset('防剧透'))).toEqual({ replacement: '[h][/h]', text: '[h][/h]', caret: 3 })
    expect(kaomojiInsertion('前后', 1, 1, preset('防剧透'))).toEqual({ replacement: '[h][/h]', text: '前[h][/h]后', caret: 4 })
  })

  it('防剧透 goes around the selection, the caret after the closing tag', () => {
    expect(kaomojiInsertion('前选中\n的字后', 1, 6, preset('防剧透'))).toEqual({
      replacement: '[h]选中\n的字[/h]',
      text: '前[h]选中\n的字[/h]后',
      caret: 13
    })
  })

  it('防剧透 wraps from the 最近使用 row as from the presets; an own kaomoji with the same text does not', () => {
    const [recent] = recentKaomojiItems(['[h][/h]'], [])
    expect(recent).toEqual({ text: '[h][/h]', name: '防剧透', wrap: { prefix: '[h]', suffix: '[/h]' } })
    expect(kaomojiInsertion('选中', 0, 2, recent!)).toMatchObject({ text: '[h]选中[/h]', caret: 9 })
    expect(kaomojiInsertion('选中', 0, 2, { text: '[h][/h]' })).toMatchObject({ text: '[h][/h]', caret: 7 })
  })
})

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

  it('refuses a blank text, 全角空格 included', () => {
    expect(newKaomoji([], '\u3000', '')).toBeNull()
    expect(newKaomoji([], ' \n\t', '空白')).toBeNull()
    expect(newKaomoji([], '\u3000x', '')).toEqual({ text: '\u3000x' })
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

  it('shows 全角空格 by its name', () => {
    expect(recentKaomojiItems(withRecentKaomoji(['[n]'], '\u3000'), [])).toMatchObject([
      { text: '\u3000', name: '全角空格' },
      { text: '[n]', name: '骰子' }
    ])
  })

  it('leaves out the earlier 防剧透 text, which is no preset any more', () => {
    expect(recentKaomojiItems(['[h] [/h]', '[n]'], []).map((item) => item.text)).toEqual(['[n]'])
  })
})

describe('decorative kaomoji', () => {
  it('come from the presets', () => {
    const presets = new Set(KAOMOJI_PRESETS.map((preset) => preset.text))
    expect(Object.values(KAOMOJI_DECOR).filter((text) => !presets.has(text))).toEqual([])
  })
})
