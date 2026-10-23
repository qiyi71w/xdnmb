// Responsive D layout. Pure: the shell measures the inputs (ResizeObserver) and renders the result.
//
// Narrowing order for what the current entry shows:
//   1. reader side gutters shrink to `minGutter` (CSS centring does this; see `gutter`);
//   2. the navigation shrinks continuously from `navFull` to `navCompactMin` (compact text bar);
//   3. the navigation becomes an overlay; only then may the reading text shrink, down to
//      `minSplitText` while the list stays beside it;
//   4. split that no longer fits shows a single pane (the entry decides list or reader).
// The list width is never shrunk to make room, and font size / line height never change.

/** What the entry shows when there is room: list + reader, the list alone, or a whole-page reader. */
export type LayoutView = 'split' | 'list' | 'reader'

export type NavStage = 'full' | 'compact' | 'overlay'

export interface LayoutInput {
  /** Available width of the window content, CSS pixels. */
  width: number
  view: LayoutView
  /** Navigation column width when nothing needs to give way (includes its outer margin). */
  navFull: number
  /** Narrowest navigation column at which every label still fits completely beside its icon. */
  navCompactMin: number
  /** Thread list width beside the reader; never shrunk first. */
  listWidth: number
  /** Preferred reading text width at the current font size (reader column max width). */
  readingWidth: number
  /** Minimum space left and right of the reading text. */
  minGutter: number
  /** Minimum reading text width while the list stays beside the reader. */
  minSplitText: number
  /** Fixed gaps and borders around the content area. */
  gap: number
}

export interface LayoutResult {
  nav: NavStage
  /** Inline navigation column width; 0 when the navigation is an overlay. */
  navWidth: number
  /** 0 at the full navigation, 1 at the compact minimum (drives the reduced padding). */
  navProgress: number
  /** Split is preferred but list and reader do not fit side by side. */
  singlePane: boolean
  /** Width of the list shown beside the reader; 0 when it is not beside it. */
  listWidth: number
  /** Resulting reading text width (or list-only content width). */
  textWidth: number
  /** Resulting space on each side of the reading text. */
  gutter: number
}

/** Initial visual parameters; the compact navigation minimum is measured from content at runtime. */
export const LAYOUT_DEFAULTS = {
  navFull: 232,
  /** Reference used only until the navigation content has been measured. */
  navCompactReference: 168,
  listWidth: 340,
  minGutter: 20,
  minSplitText: 440,
  /** Content card margins: 8px on each side. */
  gap: 16
} as const

export function computeLayout(input: LayoutInput): LayoutResult {
  const width = Math.max(0, input.width)
  const navFull = Math.max(0, input.navFull)
  const navMin = Math.min(navFull, Math.max(0, input.navCompactMin))
  const sideBySide = input.view === 'split'
  const preferred = input.gap + (sideBySide ? input.listWidth : 0) + input.readingWidth + 2 * input.minGutter

  let nav: NavStage
  let navWidth: number
  if (width >= navFull + preferred) {
    nav = 'full'
    navWidth = navFull
  } else if (navMin < navFull && width >= navMin + preferred) {
    nav = 'compact'
    navWidth = width - preferred
  } else {
    nav = 'overlay'
    navWidth = 0
  }

  const content = Math.max(0, width - navWidth - input.gap)
  // A reading width preference below the split minimum never forces single pane before the overlay stage.
  const minSplitText = Math.min(input.minSplitText, input.readingWidth)
  const singlePane = sideBySide && content < input.listWidth + minSplitText + 2 * input.minGutter
  const listWidth = sideBySide && !singlePane ? input.listWidth : 0
  const pane = Math.max(0, content - listWidth)
  const textWidth = Math.max(0, Math.min(input.readingWidth, pane - 2 * input.minGutter))
  const navProgress = nav === 'full' ? 0 : nav === 'overlay' ? 1 : (navFull - navWidth) / (navFull - navMin)

  return { nav, navWidth, navProgress, singlePane, listWidth, textWidth, gutter: (pane - textWidth) / 2 }
}
