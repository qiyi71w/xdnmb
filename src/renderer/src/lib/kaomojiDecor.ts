// Decorative kaomoji: every state that shows one, and which. One fixed kaomoji per state, each taken
// from the presets (`features/editor/kaomoji.ts`, the X 岛 `Emoticon.list`). Shown by
// `components/KaomojiDecor.tsx`: hidden from screen readers, never focusable or clickable.

export const KAOMOJI_DECOR = {
  // 空白页: above the title of a list or page with nothing in it, or at the end of a one-line one.
  /** 选择一个串: the reader of a tab before a thread is opened. */
  noThread: '(=ﾟωﾟ)=',
  /** 选择版块: a tab without a list. */
  noBoard: '( ´ー`)',
  /** 这里还没有串: a board or timeline without threads. */
  feedEmpty: '|ー` )',
  /** 没有可浏览的版面: the board directory has nothing to show. */
  directoryEmpty: '( ´ρ`)',
  /** Rows are there, but the filter or blocks leave none. */
  filteredOut: '( ´_ゝ`)',
  /** A search without results (online search, search in a thread). */
  searchEmpty: '|дﾟ )',
  draftsEmpty: '(　ˇωˇ)',
  offlineEmpty: '(・ω・)',
  historyEmpty: '( ﾟ∀ﾟ)',
  sentEmpty: '(＾o＾)ﾉ',
  remindersEmpty: '(*ﾟーﾟ)',
  subscriptionsEmpty: '(｀･ω･)',
  /** 还没有读取这份订阅 / 还没有取得列表. */
  subscriptionUnread: '(・∀・)',
  /** A sync or merge preview with nothing to change. */
  reconcileEmpty: '(*´∀`)',
  /** 还没有同步或合并记录. */
  syncJournalEmpty: '( ´・ω)',
  blocksEmpty: '(￣︶￣)',
  favoritesEmpty: '(・ー・)',
  cookiesEmpty: '(´・ω・`)',
  accountCookiesEmpty: '( ´_っ`)',
  cookieColorsEmpty: '(oﾟωﾟo)',

  // 串不存在／已删除: the thread (or other target) of a read is gone.
  missing: '(　д ) ﾟ ﾟ',

  // 失败和出错: at the end of the title of an in-page failure (notice-error blocks, list read
  // failures, one-line failure notices) and of a warning bottom notice.
  failure: '(;´Д`)',
  warningNotice: '(´ﾟДﾟ`)',

  // 关于: beside the name 汐岛.
  about: '|∀ﾟ'
} as const satisfies Record<string, string>

export type KaomojiDecorState = keyof typeof KAOMOJI_DECOR
