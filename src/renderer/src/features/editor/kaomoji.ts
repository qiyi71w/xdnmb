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

import { isKaomojiName, kaomojiTextProblem, KAOMOJI_LIMITS, type CustomKaomoji, type KaomojiTextProblem } from '../../../../shared/settings'

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

/** Why a text may not be one of the user's own: its own fault, or a preset or another own kaomoji has it. */
export type KaomojiTextRefusal = KaomojiTextProblem | 'duplicate'

/** What keeps `text` from being an own kaomoji in `custom`, the entry at `except` aside (the one being edited). */
function textRefusal(custom: readonly CustomKaomoji[], text: string, except = -1): KaomojiTextRefusal | null {
  const problem = kaomojiTextProblem(text)
  if (problem !== null) return problem
  const taken = KAOMOJI_PRESETS.some((preset) => preset.text === text) || custom.some((item, index) => index !== except && item.text === text)
  return taken ? 'duplicate' : null
}

/** The name field's `name` as stored: trimmed, left out when blank; null when it may not be a name. */
function entryName(name: string): { name?: string } | null {
  const trimmed = name.trim()
  if (trimmed === '') return {}
  return isKaomojiName(trimmed) ? { name: trimmed } : null
}

/**
 * The entry `text` and the name field's `name` add to `custom`, or null when they may not: the text
 * must be valid (`isKaomojiText`), neither a preset's text nor already added, within the count limit;
 * the name is trimmed and may be empty (no name) or else a valid one (`isKaomojiName`).
 */
export function newKaomoji(custom: readonly CustomKaomoji[], text: string, name: string): CustomKaomoji | null {
  const named = entryName(name)
  if (custom.length >= KAOMOJI_LIMITS.count || textRefusal(custom, text) !== null || named === null) return null
  return { text, ...named }
}

/** Both kaomoji settings an edit or an undone save writes together. */
export interface KaomojiLists {
  customKaomoji: CustomKaomoji[]
  recentKaomoji: string[]
}

export type KaomojiEdit =
  | ({ ok: true } & KaomojiLists)
  | { ok: false; reason: KaomojiTextRefusal | 'name' | 'missing' }

/**
 * Editing the own kaomoji whose text is `from` to `text` and the name field's `name`: it keeps its
 * place. A new text follows the rules of adding, against every other kaomoji; keeping its own text
 * and changing only the name is fine, even for one whose text a preset added later also has. The
 * name follows the rules of adding too. A changed text takes the old one's place in 最近使用, once.
 * `missing` when no own kaomoji has the text `from` (any more).
 */
export function editKaomoji(custom: readonly CustomKaomoji[], recent: readonly string[], from: string, text: string, name: string): KaomojiEdit {
  const at = custom.findIndex((item) => item.text === from)
  if (at < 0) return { ok: false, reason: 'missing' }
  const refusal = text === from ? null : textRefusal(custom, text, at)
  if (refusal !== null) return { ok: false, reason: refusal }
  const named = entryName(name)
  if (named === null) return { ok: false, reason: 'name' }
  const customKaomoji = custom.map((item, index) => (index === at ? { text, ...named } : item))
  return { ok: true, customKaomoji, recentKaomoji: renamedRecentKaomoji(recent, from, text) }
}

/** Why selected text was not saved as an own kaomoji. */
export type KaomojiSaveRefusal = KaomojiTextRefusal | 'full'

export type KaomojiSave = { ok: true; entry: CustomKaomoji; customKaomoji: CustomKaomoji[] } | { ok: false; reason: KaomojiSaveRefusal }

/**
 * What 存为颜文字 keeps of the selected text: line breaks become LF and blank lines at either end go;
 * spaces at the start and end of the remaining lines stay (a drawing's indentation).
 */
export function selectionKaomojiText(selected: string): string {
  const lines = normalizeKaomojiText(selected).split('\n')
  let start = 0
  let end = lines.length
  while (start < end && lines[start]?.trim() === '') start++
  while (end > start && lines[end - 1]?.trim() === '') end--
  return lines.slice(start, end).join('\n')
}

/**
 * 存为颜文字: the selected text (as `selectionKaomojiText` keeps it) appended to `custom` without a
 * name, under the rules of adding; else why not.
 */
export function saveSelectionAsKaomoji(custom: readonly CustomKaomoji[], selected: string): KaomojiSave {
  const text = selectionKaomojiText(selected)
  const refusal = textRefusal(custom, text)
  if (refusal !== null) return { ok: false, reason: refusal }
  if (custom.length >= KAOMOJI_LIMITS.count) return { ok: false, reason: 'full' }
  const entry = { text }
  return { ok: true, entry, customKaomoji: [...custom, entry] }
}

/**
 * Undoing 存为颜文字 of `text`: that own kaomoji leaves the list and 最近使用. Null (nothing to do)
 * when no own kaomoji has that text any more: removed, or edited to another text.
 */
export function undoSavedKaomoji(custom: readonly CustomKaomoji[], recent: readonly string[], text: string): KaomojiLists | null {
  if (!custom.some((item) => item.text === text)) return null
  return { customKaomoji: custom.filter((item) => item.text !== text), recentKaomoji: recent.filter((item) => item !== text) }
}

// 最近使用: the `recentKaomoji` setting keeps the texts of the latest inserts, latest first.

/** The recent list after inserting `text`: it moves to the front (once), keeping at most the limit. */
export function withRecentKaomoji(recent: readonly string[], text: string): string[] {
  return [text, ...recent.filter((item) => item !== text)].slice(0, KAOMOJI_LIMITS.recent)
}

/** The recent list after an own kaomoji's text changed from `from` to `to`: in its place, once. */
export function renamedRecentKaomoji(recent: readonly string[], from: string, to: string): string[] {
  const list: string[] = []
  for (const item of recent) {
    const text = item === from ? to : item
    if (!list.includes(text)) list.push(text)
  }
  return list
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
