// Kaomoji presets: the X 岛匿名版官方颜文字列表, copied verbatim (name and inserted text, in order) from
// orzogc/xdnmb_api, lib/src/xdnmb.dart (`Emoticon.list`) at commit 28fdba53031a15e0de88954679afe91b9308f71a:
// https://github.com/orzogc/xdnmb_api/blob/28fdba53031a15e0de88954679afe91b9308f71a/lib/src/xdnmb.dart
// That project is licensed under AGPL-3.0.

import { KAOMOJI_LIMITS } from '../../../../shared/settings'

/** A preset kaomoji: `name` is what its button shows, `text` what it inserts. */
export interface Kaomoji {
  name: string
  text: string
}

export const KAOMOJI_PRESETS: readonly Kaomoji[] = [
  { name: '|∀ﾟ', text: '|∀ﾟ' },
  { name: '(´ﾟДﾟ`)', text: '(´ﾟДﾟ`)' },
  { name: '(;´Д`)', text: '(;´Д`)' },
  { name: '(｀･ω･)', text: '(｀･ω･)' },
  { name: '(=ﾟωﾟ)=', text: '(=ﾟωﾟ)=' },
  { name: '| ω・´)', text: '| ω・´)' },
  { name: '|-` )', text: '|-` )' },
  { name: '|д` )', text: '|д` )' },
  { name: '|ー` )', text: '|ー` )' },
  { name: '|∀` )', text: '|∀` )' },
  { name: '(つд⊂)', text: '(つд⊂)' },
  { name: '(ﾟДﾟ≡ﾟДﾟ)', text: '(ﾟДﾟ≡ﾟДﾟ)' },
  { name: '(＾o＾)ﾉ', text: '(＾o＾)ﾉ' },
  { name: '(|||ﾟДﾟ)', text: '(|||ﾟДﾟ)' },
  { name: '( ﾟ∀ﾟ)', text: '( ﾟ∀ﾟ)' },
  { name: '( ´∀`)', text: '( ´∀`)' },
  { name: '(*´∀`)', text: '(*´∀`)' },
  { name: '(*ﾟ∇ﾟ)', text: '(*ﾟ∇ﾟ)' },
  { name: '(*ﾟーﾟ)', text: '(*ﾟーﾟ)' },
  { name: '(　ﾟ 3ﾟ)', text: '(　ﾟ 3ﾟ)' },
  { name: '( ´ー`)', text: '( ´ー`)' },
  { name: '( ・_ゝ・)', text: '( ・_ゝ・)' },
  { name: '( ´_ゝ`)', text: '( ´_ゝ`)' },
  { name: '(*´д`)', text: '(*´д`)' },
  { name: '(・ー・)', text: '(・ー・)' },
  { name: '(・∀・)', text: '(・∀・)' },
  { name: '(ゝ∀･)', text: '(ゝ∀･)' },
  { name: '(〃∀〃)', text: '(〃∀〃)' },
  { name: '(*ﾟ∀ﾟ*)', text: '(*ﾟ∀ﾟ*)' },
  { name: '( ﾟ∀。)', text: '( ﾟ∀。)' },
  { name: '( `д´)', text: '( `д´)' },
  { name: '(`ε´ )', text: '(`ε´ )' },
  { name: '(`ヮ´ )', text: '(`ヮ´ )' },
  { name: 'σ`∀´)', text: 'σ`∀´)' },
  { name: ' ﾟ∀ﾟ)σ', text: ' ﾟ∀ﾟ)σ' },
  { name: 'ﾟ ∀ﾟ)ノ', text: 'ﾟ ∀ﾟ)ノ' },
  { name: '(╬ﾟдﾟ)', text: '(╬ﾟдﾟ)' },
  { name: '(|||ﾟдﾟ)', text: '(|||ﾟдﾟ)' },
  { name: '( ﾟдﾟ)', text: '( ﾟдﾟ)' },
  { name: 'Σ( ﾟдﾟ)', text: 'Σ( ﾟдﾟ)' },
  { name: '( ;ﾟдﾟ)', text: '( ;ﾟдﾟ)' },
  { name: '( ;´д`)', text: '( ;´д`)' },
  { name: '(　д ) ﾟ ﾟ', text: '(　д ) ﾟ ﾟ' },
  { name: '( ☉д⊙)', text: '( ☉д⊙)' },
  { name: '(((　ﾟдﾟ)))', text: '(((　ﾟдﾟ)))' },
  { name: '( ` ・´)', text: '( ` ・´)' },
  { name: '( ´д`)', text: '( ´д`)' },
  { name: '( -д-)', text: '( -д-)' },
  { name: '(>д<)', text: '(>д<)' },
  { name: '･ﾟ( ﾉд`ﾟ)', text: '･ﾟ( ﾉд`ﾟ)' },
  { name: '( TдT)', text: '( TдT)' },
  { name: '(￣∇￣)', text: '(￣∇￣)' },
  { name: '(￣3￣)', text: '(￣3￣)' },
  { name: '(￣ｰ￣)', text: '(￣ｰ￣)' },
  { name: '(￣ . ￣)', text: '(￣ . ￣)' },
  { name: '(￣皿￣)', text: '(￣皿￣)' },
  { name: '(￣艸￣)', text: '(￣艸￣)' },
  { name: '(￣︿￣)', text: '(￣︿￣)' },
  { name: '(￣︶￣)', text: '(￣︶￣)' },
  { name: 'ヾ(´ωﾟ｀)', text: 'ヾ(´ωﾟ｀)' },
  { name: '(*´ω`*)', text: '(*´ω`*)' },
  { name: '(・ω・)', text: '(・ω・)' },
  { name: '( ´・ω)', text: '( ´・ω)' },
  { name: '(｀・ω)', text: '(｀・ω)' },
  { name: '(´・ω・`)', text: '(´・ω・`)' },
  { name: '(`・ω・´)', text: '(`・ω・´)' },
  { name: '( `_っ´)', text: '( `_っ´)' },
  { name: '( `ー´)', text: '( `ー´)' },
  { name: '( ´_っ`)', text: '( ´_っ`)' },
  { name: '( ´ρ`)', text: '( ´ρ`)' },
  { name: '( ﾟωﾟ)', text: '( ﾟωﾟ)' },
  { name: '(oﾟωﾟo)', text: '(oﾟωﾟo)' },
  { name: '(　^ω^)', text: '(　^ω^)' },
  { name: '(｡◕∀◕｡)', text: '(｡◕∀◕｡)' },
  { name: '/( ◕‿‿◕ )\\', text: '/( ◕‿‿◕ )\\' },
  { name: 'ヾ(´ε`ヾ)', text: 'ヾ(´ε`ヾ)' },
  { name: '(ノﾟ∀ﾟ)ノ', text: '(ノﾟ∀ﾟ)ノ' },
  { name: '(σﾟдﾟ)σ', text: '(σﾟдﾟ)σ' },
  { name: '(σﾟ∀ﾟ)σ', text: '(σﾟ∀ﾟ)σ' },
  { name: '|дﾟ )', text: '|дﾟ )' },
  { name: '┃電柱┃', text: '┃電柱┃' },
  { name: 'ﾟ(つд`ﾟ)', text: 'ﾟ(つд`ﾟ)' },
  { name: 'ﾟÅﾟ )　', text: 'ﾟÅﾟ )　' },
  { name: '⊂彡☆))д`)', text: '⊂彡☆))д`)' },
  { name: '⊂彡☆))д´)', text: '⊂彡☆))д´)' },
  { name: '⊂彡☆))∀`)', text: '⊂彡☆))∀`)' },
  { name: '(´∀((☆ミつ', text: '(´∀((☆ミつ' },
  { name: '･ﾟ( ﾉヮ´ )', text: '･ﾟ( ﾉヮ´ )' },
  { name: '(ﾉ)`ω´(ヾ)', text: '(ﾉ)`ω´(ヾ)' },
  { name: 'ᕕ( ᐛ )ᕗ', text: 'ᕕ( ᐛ )ᕗ' },
  { name: '(　ˇωˇ)', text: '(　ˇωˇ)' },
  { name: '( ｣ﾟДﾟ)｣＜', text: '( ｣ﾟДﾟ)｣＜' },
  { name: '( ›´ω`‹ )', text: '( ›´ω`‹ )' },
  { name: '(;´ヮ`)7', text: '(;´ヮ`)7' },
  { name: '(`ゥ´ )', text: '(`ゥ´ )' },
  { name: '(`ᝫ´ )', text: '(`ᝫ´ )' },
  { name: '( ᑭ`д´)ᓀ))д´)ᑫ', text: '( ᑭ`д´)ᓀ))д´)ᑫ' },
  { name: 'σ( ᑒ )', text: 'σ( ᑒ )' },
  { name: '齐齐蛤尔', text: '(`ヮ´ )σ`∀´) ﾟ∀ﾟ)σ' },
  { name: '大嘘', text: '吁~~~~　　rnm，退钱！\n 　　　/　　　/ \n(　ﾟ 3ﾟ) `ー´) `д´) `д´)\n' },
  { name: '防剧透', text: '[h] [/h]' },
  { name: '骰子', text: '[n]' },
  { name: '高级骰子', text: '[n,m]' }
]

// The user's own kaomoji come after the presets; they are the `customKaomoji` setting.

/** Control characters other than tab and line feed (refused by the setting's validation). */
const FORBIDDEN = /[\u0000-\u0008\u000b-\u001f\u007f]/

/**
 * Whether `text` may be added to `custom`: not blank, neither a preset's text nor already added,
 * and within the setting's limits (`KAOMOJI_LIMITS`, no control characters).
 */
export function canAddKaomoji(custom: readonly string[], text: string): boolean {
  return (
    text.trim() !== '' &&
    custom.length < KAOMOJI_LIMITS.count &&
    [...text].length <= KAOMOJI_LIMITS.length &&
    !FORBIDDEN.test(text) &&
    !custom.includes(text) &&
    !KAOMOJI_PRESETS.some((preset) => preset.text === text)
  )
}
