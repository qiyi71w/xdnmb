// Kaomoji presets, in the panel's order.
//
// The X 岛匿名版官方颜文字列表: its first 100 entries, copied verbatim (name and inserted text, in order)
// from orzogc/xdnmb_api, lib/src/xdnmb.dart (`Emoticon.list`) at commit 28fdba53031a15e0de88954679afe91b9308f71a:
// https://github.com/orzogc/xdnmb_api/blob/28fdba53031a15e0de88954679afe91b9308f71a/lib/src/xdnmb.dart
// 防剧透, 骰子 and 高级骰子 end that list too; 防剧透 inserts `[h][/h]` here, without the list's space.
//
// 蓝岛颜文字: copied verbatim (name and inserted text, in order) from orzogc/xdnmb,
// lib/app/utils/emoticons.dart (`blueIslandEmoticons`) at commit 2467f43d58b837c02b1fe72da1c7ca6484ab50d9:
// https://github.com/orzogc/xdnmb/blob/2467f43d58b837c02b1fe72da1c7ca6484ab50d9/lib/app/utils/emoticons.dart
// without its first entry `･ﾟ( ﾉヮ´ )`, which the official list has. Its raw Dart strings are taken
// literally, trailing line breaks included; a no-break space (U+00A0) is written `\u00a0` here.
//
// Both projects are licensed under AGPL-3.0.

import { isKaomojiName, isKaomojiText, KAOMOJI_LIMITS, type CustomKaomoji } from '../../../../shared/settings'

/** What 防剧透 puts around the selection: `prefix` before it, `suffix` after it. */
export interface KaomojiWrap {
  prefix: string
  suffix: string
}

/**
 * A preset kaomoji: `name` is what its button shows, `text` what it inserts and how 最近使用 knows it.
 * One with a `wrap` goes around the selection instead of replacing it (see `kaomojiInsertion`).
 */
export interface Kaomoji {
  name: string
  text: string
  wrap?: KaomojiWrap
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
  { name: '( ´_ゝ`)旦', text: '( ´_ゝ`)旦' },
  { name: '(<ゝω・) ☆', text: '(<ゝω・) ☆' },
  { name: '(`ε´ (つ*⊂)', text: '(`ε´ (つ*⊂)' },
  { name: '=͟͟͞͞( \'ヮ\' 三 \'ヮ\' =͟͟͞͞)', text: '=͟͟͞͞( \'ヮ\' 三 \'ヮ\' =͟͟͞͞)' },
  { name: '↙(`ヮ´ )↗ 开摆！', text: '↙(`ヮ´ )↗ 开摆！' },
  { name: '(っ˘Д˘)ノ<', text: '(っ˘Д˘)ノ<' },
  { name: '(ﾉ#)`д´)σ', text: '(ﾉ#)`д´)σ' },
  { name: '₍₍(ง`ᝫ´ )ว⁾', text: '₍₍(ง`ᝫ´ )ว⁾' },
  { name: '( `ᵂ´)', text: '( `ᵂ´)' },
  { name: '( *・ω・)✄╰ひ╯', text: '( *・ω・)✄╰ひ╯' },
  { name: 'U•ェ•*U', text: 'U•ェ•*U' },
  { name: '⊂( ﾟωﾟ)つ', text: '⊂( ﾟωﾟ)つ' },
  { name: '( ﾟ∀。)7', text: '( ﾟ∀。)7' },
  { name: '･ﾟ( ﾟ∀。) ﾟ。', text: '･ﾟ( ﾟ∀。) ﾟ。' },
  { name: '( `д´)σ', text: '( `д´)σ' },
  { name: '( ﾟᯅ 。)', text: '( ﾟᯅ 。)' },
  { name: '( ;`д´; )', text: '( ;`д´; )' },
  { name: 'm9( `д´)', text: 'm9( `д´)' },
  { name: '( ﾟπ。)', text: '( ﾟπ。)' },
  { name: 'ᕕ( ﾟ∀。)ᕗ', text: 'ᕕ( ﾟ∀。)ᕗ' },
  { name: 'ฅ(^ω^ฅ)', text: 'ฅ(^ω^ฅ)' },
  { name: '(|||^ヮ^)', text: '(|||^ヮ^)' },
  { name: '(|||ˇヮˇ)', text: '(|||ˇヮˇ)' },
  { name: '(　↺ω↺)', text: '(　↺ω↺)' },
  { name: '\u00a0`ー´) `д´) `д´)', text: '\u00a0`ー´) `д´) `д´)' },
  { name: '接☆龙☆大☆成☆功', text: '接☆龙☆大☆成☆功' },
  { name: 'ᑭ`д´)ᓀ ∑ᑭ(`ヮ´ )ᑫ', text: 'ᑭ`д´)ᓀ ∑ᑭ(`ヮ´ )ᑫ' },
  { name: '乚 (^ω^ ﾐэ)Э好钩我咬', text: '乚 (^ω^ ﾐэ)Э好钩我咬' },
  { name: '乚(`ヮ´  ﾐэ)Э', text: '乚(`ヮ´  ﾐэ)Э' },
  { name: '( ﾟ∀。ﾐэ)Э三三三三　乚', text: '( ﾟ∀。ﾐэ)Э三三三三　乚' },
  { name: '(ˇωˇ ﾐэ)Э三三三三　乚', text: '(ˇωˇ ﾐэ)Э三三三三　乚' },
  { name: '( へ ﾟ∀ﾟ)べ摔低低', text: '( へ ﾟ∀ﾟ)べ摔低低' },
  { name: '(ベ ˇωˇ)べ 摔低低', text: '(ベ ˇωˇ)べ 摔低低' },
  { name: '呼伦悲尔', text: '( ﾉд`ﾟ);´д`) ´_ゝ`) ' },
  { name: '鄂尔多厮', text: 'Σ( ﾟдﾟ)´ﾟДﾟ)　ﾟдﾟ)))' },
  { name: '智利', text: '( ﾟ∀。)∀。)∀。)' },
  { name: '阴山山脉', text: '(　ˇωˇ )◕∀◕｡)^ω^)' },
  { name: 'F5欧拉', text: '　σ　σ\nσ(　´ρ`)σ[F5]\n　σ　σ\n' },
  { name: 'UK酱', text: '\\ ︵\nᐕ)⁾⁾\n' },
  { name: '白羊', text: '╭◜◝ ͡ ◜◝ J\u00a0J\n(　　　　 `д´) 　“咩！”\n╰◟д ◞ ͜ ◟д◞\n' },
  { name: '兔兔', text: '\u00a0  \u00a0 /)　/)\nc(　╹^╹)\n' },
  { name: 'neko', text: '　　\u00a0\u00a0\u00a0\u00a0\u00a0\u00a0 　∧,,　\n　　　　ヾ ｀. ､`フ\n　　　(,｀\'´ヽ､､ﾂﾞ\n　 (ヽｖ\'　　　`\'\'ﾞつ\n　　,ゝ　 ⌒`ｙ\'\'\'´\n　 （ (´＾ヽこつ\n　　 ) )\n　　(ノ\n' },
  { name: '给你', text: '（\\_/）\n(・_・)\n\u00a0/ 　>' },
  { name: '举高高', text: '　　　　_∧＿∧_ 　　　　\n\u00a0 \u00a0 \u00a0 \u00a0 \u00a0 \u00a0 ((∀｀/ 　) 　　\n　 \u00a0 \u00a0 \u00a0 /⌒　　 ／ 　　\n\u00a0 \u00a0 \u00a0 \u00a0 \u00a0/(__ノ＼_ノ 　　\n\u00a0 \u00a0 \u00a0 \u00a0 \u00a0 (_ノ ||| 举高高~~\n　∧＿∧　∧＿∧\n\u00a0(( ・∀・ ))・∀・) )\n\u00a0`＼　　 ∧ 　　ノ\n　/　　｜/　　｜\n（＿ノ＿)_ノL＿)\n' },
  { name: '举糕糕', text: '举糕糕~\n　　☆☆☆☆☆☆☆☆\n\u00a0　╭┻┻┻┻┻┻┻┻╮\n\u00a0　┃╱╲╱╲╱╲╱╲┃\n\u00a0╭┻━━━━━━━━┻╮\n\u00a0┃╱╲╱╲╱╲╱╲╱╲┃\n\u00a0┗━━━━━━━━━━┛\n\u00a0　　　∧＿∧　∧＿∧\n　　(( ・∀・ ))・∀・) )\n\u00a0　　`＼　　 ∧ 　　ノ\n　　　/　　｜/　　｜\n\u00a0　　（＿ノ＿)_ノL＿)\n' },
  { name: 'Happy肥肥Day', text: '. 　　　　 \u00a0 　.★ * ★.. 　\n\u00a0　.*★　*.　*..*　　　★ 　\n\u00a0　★　　　　　　 ★ 　　\n\u00a0 \u00a0 \u00a0‘*. *\'　 ʜᴀᴘᴘʏ 肥肥 ᴅᴀʏ 　　　\n\u00a0 \u00a0 \u00a0 \u00a0 \u00a0‘★.　　 ★’ 　　　　 　　\n\u00a0 \u00a0 \u00a0 \u00a0 \u00a0 \u00a0 \u00a0 \u00a0‘*..★\n┊┊┊┊☆☆☆☆☆☆☆☆┊┊┊┊\n┊┊┊╭┻┻┻┻┻┻┻┻╮┊┊┊\n┊┊┊┃╱╲╱╲╱╲╱╲┃┊┊┊\n┊┊╭┻━━━━━━━━┻╮┊┊\n┊┊┃╱╲╱╲╱╲╱╲╱╲┃┊┊\n╱▔┗━━━━━━━━━━┛▔╲\n' },
  { name: '举高高2', text: '\u00a0 \u00a0 \u00a0 \u00a0 \u00a0 \u00a0 \u00a0 _∧＿∧_\n　　　 ((∀｀/ 　)\n　　　 /⌒　　 ／\n　 /(__ノ＼_ノ(((ヽ\n　(_ノ　 　￣Ｙ＼\n|　(＼　(\\　 /)　 ｜ )举高高！\nヽ　ヽ` ( ﾟ∀ﾟ ) _ノ /\n　＼ |　⌒Ｙ⌒　/ /\n　 ｜ヽ · ｜ · ﾉ ／/\n　 ＼トー仝ーイ\n　　 ｜ ミ土彡/\n　　　). \\ °　 /\n　　　( 　\\. y 　\\\n' },
  { name: '催更喵gkd', text: '　　　　　　＿＿＿\n　　　　　／＞　　フ\n　　　　　|  　_　 _ l 我是一只催更的\n　 　　　／` ミ＿xノ 喵喵酱\n　　 　 /　　　 　 | gkdgkd\n　　　 /　 ヽ　　 ﾉ\n　 　 │　　|　|　|\n　／￣|　　 |　|　|\n　| (￣ヽ＿_ヽ_)__)\n　＼二つ\n' },
  { name: '巴拉巴拉', text: '　∧＿∧\n（｡･ω･｡)つ━☆・*。\n ⊂　　 ノ 　　　・゜+.\n　しーＪ　　　°。+ *´¨)\n　　　 　　.· ´¸.·*´¨) ¸.·*¨)\n　　　　　　　 　(¸.·´ (¸.·’*\n' },
  { name: '防剧透', text: '[h][/h]', wrap: { prefix: '[h]', suffix: '[/h]' } },
  { name: '骰子', text: '[n]' },
  { name: '高级骰子', text: '[n,m]' },
  { name: '全角空格', text: '\u3000' }
]

/** What pressing a kaomoji inserts: a preset brings its `wrap`; the user's own kaomoji have none. */
export type KaomojiInsert = Pick<Kaomoji, 'text' | 'wrap'>

/**
 * Inserting `kaomoji` into `value`, whose selection is `start`–`end` (equal for a bare caret):
 * `replacement` takes the selection's place, `text` is the whole text afterwards, `caret` where the
 * caret ends. A plain kaomoji replaces the selection, the caret after it. One with a `wrap` goes
 * around the selection, the caret after the suffix; with nothing selected the caret ends between
 * prefix and suffix, where the enclosed text is typed.
 */
export function kaomojiInsertion(
  value: string,
  start: number,
  end: number,
  kaomoji: KaomojiInsert
): { replacement: string; text: string; caret: number } {
  const { wrap } = kaomoji
  const replacement = wrap === undefined ? kaomoji.text : wrap.prefix + value.slice(start, end) + wrap.suffix
  const caret = wrap !== undefined && start === end ? start + wrap.prefix.length : start + replacement.length
  return { replacement, text: value.slice(0, start) + replacement + value.slice(end), caret }
}

// The user's own kaomoji come after the presets; they are the `customKaomoji` setting.

/** Pasted CRLF / CR line breaks become LF before validation. */
export function normalizeKaomojiText(text: string): string {
  return text.replace(/\r\n?/g, '\n')
}

/**
 * The entry `text` and the name field's `name` add to `custom`, or null when they may not: the text
 * must be valid (`isKaomojiText`), neither a preset's text nor already added, within the count limit;
 * the name is trimmed and may be empty (no name) or else a valid one (`isKaomojiName`).
 */
export function newKaomoji(custom: readonly CustomKaomoji[], text: string, name: string): CustomKaomoji | null {
  const trimmed = name.trim()
  if (
    custom.length >= KAOMOJI_LIMITS.count ||
    !isKaomojiText(text) ||
    custom.some((item) => item.text === text) ||
    KAOMOJI_PRESETS.some((preset) => preset.text === text) ||
    (trimmed !== '' && !isKaomojiName(trimmed))
  ) {
    return null
  }
  return trimmed === '' ? { text } : { text, name: trimmed }
}

// 最近使用: the `recentKaomoji` setting keeps the texts of the latest inserts, latest first.

/** The recent list after inserting `text`: it moves to the front (once), keeping at most the limit. */
export function withRecentKaomoji(recent: readonly string[], text: string): string[] {
  return [text, ...recent.filter((item) => item !== text)].slice(0, KAOMOJI_LIMITS.recent)
}

/** One button of the 最近使用 row: `name` is what it shows (null shows the text itself). */
export interface RecentKaomoji extends KaomojiInsert {
  name: string | null
}

/**
 * The 最近使用 row for `recent`: each text that is still a preset or one of the user's own, with the
 * name its button shows elsewhere and, for a preset, its `wrap`; a removed kaomoji is left out.
 */
export function recentKaomojiItems(recent: readonly string[], custom: readonly CustomKaomoji[]): RecentKaomoji[] {
  const items: RecentKaomoji[] = []
  for (const text of recent) {
    const preset = KAOMOJI_PRESETS.find((item) => item.text === text)
    if (preset !== undefined) {
      items.push({ text, name: preset.name === text ? null : preset.name, wrap: preset.wrap })
      continue
    }
    const own = custom.find((item) => item.text === text)
    if (own !== undefined) items.push({ text, name: own.name ?? null })
  }
  return items
}
