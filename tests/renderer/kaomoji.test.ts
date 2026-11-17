import { describe, expect, it } from 'vitest'
import {
  editKaomoji, KAOMOJI_PRESETS, kaomojiInsertion, newKaomoji, normalizeKaomojiText, recentKaomojiItems, saveSelectionAsKaomoji,
  undoSavedKaomoji, withRecentKaomoji
} from '../../src/renderer/src/features/editor/kaomoji'
import { INITIAL_KAOMOJI_SAVE, kaomojiSaveReducer } from '../../src/renderer/src/features/editor/kaomojiSaveState'
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

describe('editing an own kaomoji', () => {
  const custom = [{ text: 'a' }, { text: 'b', name: '乙' }, { text: 'c' }]

  it('keeps its place, with the new text and name', () => {
    const result = editKaomoji(custom, [], 'b', 'B', '  新名  ')
    expect(result).toMatchObject({ ok: true, customKaomoji: [{ text: 'a' }, { text: 'B', name: '新名' }, { text: 'c' }] })
    expect(editKaomoji(custom, [], 'b', 'B', '')).toMatchObject({ ok: true, customKaomoji: [{ text: 'a' }, { text: 'B' }, { text: 'c' }] })
  })

  it('refuses a text that a preset (蓝岛 ones included) or another own kaomoji has', () => {
    expect(editKaomoji(custom, [], 'b', preset('呼伦悲尔').text, '')).toEqual({ ok: false, reason: 'duplicate' })
    expect(editKaomoji(custom, [], 'b', 'c', '')).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('may keep its text and change only the name', () => {
    expect(editKaomoji(custom, [], 'b', 'b', '丙')).toMatchObject({ ok: true, customKaomoji: [{ text: 'a' }, { text: 'b', name: '丙' }, { text: 'c' }] })
  })

  it('may rename one kept from before whose text a 蓝岛 preset now has, but not take that text for another', () => {
    const text = preset('呼伦悲尔').text
    const kept = [{ text: 'a' }, { text, name: '旧名' }]
    expect(editKaomoji(kept, [text], text, text, '新名')).toEqual({ ok: true, customKaomoji: [{ text: 'a' }, { text, name: '新名' }], recentKaomoji: [text] })
    expect(editKaomoji(kept, [], 'a', text, '')).toEqual({ ok: false, reason: 'duplicate' })
  })

  it('refuses a name past 16 characters, a blank text, and a kaomoji no longer there', () => {
    expect(editKaomoji(custom, [], 'b', 'b', '一二三四五六七八九十一二三四五六七')).toEqual({ ok: false, reason: 'name' })
    expect(editKaomoji(custom, [], 'b', ' \n', '')).toEqual({ ok: false, reason: 'blank' })
    expect(editKaomoji(custom, [], 'gone', 'x', '')).toEqual({ ok: false, reason: 'missing' })
  })

  it('puts the new text in place of the old one in 最近使用, once', () => {
    expect(editKaomoji(custom, ['[n]', 'b', 'a'], 'b', 'B', '')).toMatchObject({ recentKaomoji: ['[n]', 'B', 'a'] })
    // An old text that is no kaomoji any more (the earlier 防剧透) can be in the list already.
    expect(editKaomoji(custom, ['[h] [/h]', 'a', 'b'], 'b', '[h] [/h]', '')).toMatchObject({ recentKaomoji: ['[h] [/h]', 'a'] })
  })
})

describe('saving selected text as a kaomoji', () => {
  it('turns CRLF into LF and drops blank lines at either end, keeping the spaces that start a line', () => {
    const result = saveSelectionAsKaomoji([{ text: 'x' }], '\r\n  \r\n  ∧＿∧\r\n （´・ω・） \r\n\r\n')
    expect(result).toEqual({ ok: true, entry: { text: '  ∧＿∧\n （´・ω・） ' }, customKaomoji: [{ text: 'x' }, { text: '  ∧＿∧\n （´・ω・） ' }] })
  })

  it('says why it saved nothing: blank, too long, control characters, already there, list full', () => {
    expect(saveSelectionAsKaomoji([], ' \n\u3000\n')).toEqual({ ok: false, reason: 'blank' })
    expect(saveSelectionAsKaomoji([], 'x'.repeat(501))).toEqual({ ok: false, reason: 'too-long' })
    expect(saveSelectionAsKaomoji([], 'a\u0001b')).toEqual({ ok: false, reason: 'forbidden' })
    expect(saveSelectionAsKaomoji([], `\n${preset('呼伦悲尔').text}\n`)).toEqual({ ok: false, reason: 'duplicate' })
    expect(saveSelectionAsKaomoji([{ text: 'mine', name: '我的' }], 'mine')).toEqual({ ok: false, reason: 'duplicate' })
    const full = Array.from({ length: 200 }, (_, index) => ({ text: `k${index}` }))
    expect(saveSelectionAsKaomoji(full, 'new')).toEqual({ ok: false, reason: 'full' })
  })

  it('undoes back to the lists before the save', () => {
    const before = [{ text: 'a' }]
    const saved = saveSelectionAsKaomoji(before, 'new')
    if (!saved.ok) throw new Error('not saved')
    // Inserted after saving, it is in 最近使用 too.
    expect(undoSavedKaomoji(saved.customKaomoji, ['new', '[n]'], 'new')).toEqual({ customKaomoji: before, recentKaomoji: ['[n]'] })
  })

  it('undoes nothing once the saved kaomoji was removed or its text edited', () => {
    expect(undoSavedKaomoji([{ text: 'a' }], ['a'], 'new')).toBeNull()
    const edited = editKaomoji([{ text: 'a' }, { text: 'new' }], [], 'new', 'newer', '')
    if (!edited.ok) throw new Error('not edited')
    expect(undoSavedKaomoji(edited.customKaomoji, [], 'new')).toBeNull()
  })
})

describe('the 存为颜文字 notice', () => {
  const savedA = () => {
    const writing = kaomojiSaveReducer(INITIAL_KAOMOJI_SAVE, { type: 'writing', id: 1 })
    return kaomojiSaveReducer(writing, { type: 'written', id: 1, saved: true, entry: { text: 'A' } })
  }

  it('shows 已存为颜文字 only once the write is saved, and 设置未保存 when it is not', () => {
    const writing = kaomojiSaveReducer(INITIAL_KAOMOJI_SAVE, { type: 'writing', id: 1 })
    expect(writing.notice).toBeNull()
    expect(savedA().notice).toEqual({ kind: 'saved', id: 1, entry: { text: 'A' }, undo: 'idle', rewrite: false, gone: false })
    expect(kaomojiSaveReducer(writing, { type: 'written', id: 1, saved: false, entry: { text: 'A' } }).notice).toEqual({ kind: 'not-saved', id: 1 })
  })

  it('keeps the notice while 撤销 is under way, and with 撤销 again when it was not saved', () => {
    const busy = kaomojiSaveReducer(savedA(), { type: 'undoing', id: 1 })
    expect(busy.notice).toMatchObject({ kind: 'saved', undo: 'busy' })
    const failed = kaomojiSaveReducer(busy, { type: 'undone', id: 1, saved: false, listed: true })
    expect(failed.notice).toMatchObject({ kind: 'saved', entry: { text: 'A' }, undo: 'failed', rewrite: false })
    expect(kaomojiSaveReducer(busy, { type: 'undone', id: 1, saved: false, listed: false }).notice).toMatchObject({ undo: 'failed', rewrite: true })
    expect(kaomojiSaveReducer(kaomojiSaveReducer(failed, { type: 'undoing', id: 1 }), { type: 'undone', id: 1, saved: true, listed: false }).notice).toBeNull()
  })

  it('keeps rewriting once a 撤销 failed without rolling back, even if the text is listed again', () => {
    const busy = kaomojiSaveReducer(savedA(), { type: 'undoing', id: 1 })
    const rewrite = kaomojiSaveReducer(busy, { type: 'undone', id: 1, saved: false, listed: false })
    // The same text added since, then trying again fails too: still only a rewrite.
    const again = kaomojiSaveReducer(kaomojiSaveReducer(rewrite, { type: 'undoing', id: 1 }), { type: 'undone', id: 1, saved: false, listed: true })
    expect(again.notice).toMatchObject({ undo: 'failed', rewrite: true })
  })

  it('marks the saved kaomoji gone once removed or edited, unless its own 撤销 took it out of the lists', () => {
    expect(kaomojiSaveReducer(savedA(), { type: 'gone', id: 1 }).notice).toMatchObject({ gone: true })
    const busy = kaomojiSaveReducer(savedA(), { type: 'undoing', id: 1 })
    expect(kaomojiSaveReducer(busy, { type: 'gone', id: 1 })).toBe(busy)
    // Rolled back after a failed 撤销, it is listed again: removing or editing it later still counts.
    const failed = kaomojiSaveReducer(busy, { type: 'undone', id: 1, saved: false, listed: true })
    expect(kaomojiSaveReducer(failed, { type: 'gone', id: 1 }).notice).toMatchObject({ gone: true })
    // Not rolled back, it is out of the lists because of the 撤销 itself.
    const rewrite = kaomojiSaveReducer(busy, { type: 'undone', id: 1, saved: false, listed: false })
    expect(kaomojiSaveReducer(rewrite, { type: 'gone', id: 1 })).toBe(rewrite)
  })

  it('keeps the latest save only: after A then B, only B shows and its undo leaves A', () => {
    const a = saveSelectionAsKaomoji([], 'A')
    if (!a.ok) throw new Error('A not saved')
    const b = saveSelectionAsKaomoji(a.customKaomoji, 'B')
    if (!b.ok) throw new Error('B not saved')
    let state = kaomojiSaveReducer(INITIAL_KAOMOJI_SAVE, { type: 'writing', id: 1 })
    state = kaomojiSaveReducer(state, { type: 'written', id: 1, saved: true, entry: a.entry })
    state = kaomojiSaveReducer(state, { type: 'writing', id: 2 })
    state = kaomojiSaveReducer(state, { type: 'written', id: 2, saved: true, entry: b.entry })
    expect(state.notice).toEqual({ kind: 'saved', id: 2, entry: { text: 'B' }, undo: 'idle', rewrite: false, gone: false })
    // A reply to an earlier attempt arriving late changes nothing.
    expect(kaomojiSaveReducer(state, { type: 'written', id: 1, saved: true, entry: a.entry })).toBe(state)
    expect(undoSavedKaomoji(b.customKaomoji, [], 'B')?.customKaomoji).toEqual([{ text: 'A' }])
  })

  it('replaces a shown notice with the reason a later save was refused', () => {
    let state = kaomojiSaveReducer(INITIAL_KAOMOJI_SAVE, { type: 'writing', id: 1 })
    state = kaomojiSaveReducer(state, { type: 'written', id: 1, saved: true, entry: { text: 'A' } })
    state = kaomojiSaveReducer(state, { type: 'refused', id: 2, reason: 'duplicate' })
    expect(state.notice).toEqual({ kind: 'refused', id: 2, reason: 'duplicate' })
    expect(kaomojiSaveReducer(state, { type: 'dismiss', id: 1 })).toBe(state)
    expect(kaomojiSaveReducer(state, { type: 'dismiss', id: 2 }).notice).toBeNull()
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
