// Responsive D layout. Pure: the shell measures the inputs (ResizeObserver) and renders the result.
//
// Narrowing order for what the current entry shows:
//   1. reader side gutters shrink to `minGutter` before the text and `readerEndGutter` after it
//      (CSS centring and the jump-button lane do this; see `gutter`);
//   2. the navigation (the icon rail) becomes an overlay; only then may the reading text shrink,
//      down to `minSplitText` while the list stays beside it;
//   3. split that no longer fits shows a single pane (the entry decides list or reader).
// The list width is never shrunk to make room, and font size / line height never change.
// A list the user widened beyond `listWidth` (`listGrow`) takes its extra width from the reading
// text only, down to `minSplitText`, once the steps above are settled: widening never moves the
// navigation or forces the single pane, and narrowing the window gives that extra width back first.

/** What the entry shows when there is room: list + reader, the list alone, or a whole-page reader. */
export type LayoutView = 'split' | 'list' | 'reader'

export type NavStage = 'full' | 'overlay'

export interface LayoutInput {
  /** Available width of the window content, CSS pixels. */
  width: number
  view: LayoutView
  /** Navigation column width (includes its outer margin). */
  navFull: number
  /** Thread list width beside the reader; never shrunk first. */
  listWidth: number
  /** Extra list width the user asked for beyond `listWidth`; granted only while the reader keeps `minSplitText`. */
  listGrow?: number
  /** Preferred reading text width at the current font size (reader column max width). */
  readingWidth: number
  /** Minimum space left of the reading text, and on both sides of a list shown alone. */
  minGutter: number
  /** Minimum space right of the reading text whenever the reader is shown (views 'split' and 'reader'). */
  readerEndGutter: number
  /** Minimum reading text width while the list stays beside the reader. */
  minSplitText: number
  /** Fixed gaps and borders around the content area. */
  gap: number
}

export interface LayoutResult {
  nav: NavStage
  /** Inline navigation column width; 0 when the navigation is an overlay. */
  navWidth: number
  /** Split is preferred but list and reader do not fit side by side. */
  singlePane: boolean
  /** Width of the list shown beside the reader; 0 when it is not beside it. */
  listWidth: number
  /** Widest list the reader currently leaves room for (`listWidth` at least); 0 when not beside it. */
  listWidthMax: number
  /** Resulting reading text width (or list-only content width). */
  textWidth: number
  /** Resulting space on each side of the reading text when centred; the reader's end side keeps at least `readerEndGutter`. */
  gutter: number
}

/** Initial visual parameters. */
export const LAYOUT_DEFAULTS = {
  listWidth: 340,
  minGutter: 20,
  /** The reader's end lane for the corner jump buttons: `--jump-lane` in thread.css (16px inset + 32px button + 8px clearance). */
  readerEndGutter: 56,
  minSplitText: 440,
  /** Content card margins: 8px on each side. */
  gap: 16
} as const

export function computeLayout(input: LayoutInput): LayoutResult {
  const width = Math.max(0, input.width)
  const navFull = Math.max(0, input.navFull)
  const sideBySide = input.view === 'split'
  // Space the reader keeps beside its text; a list shown alone keeps `minGutter` on both sides.
  const sides = input.view === 'list' ? 2 * input.minGutter : input.minGutter + input.readerEndGutter
  const preferred = input.gap + (sideBySide ? input.listWidth : 0) + input.readingWidth + sides

  const nav: NavStage = width >= navFull + preferred ? 'full' : 'overlay'
  const navWidth = nav === 'full' ? navFull : 0

  const content = Math.max(0, width - navWidth - input.gap)
  // A reading width preference below the split minimum never forces single pane before the overlay stage.
  const minSplitText = Math.min(input.minSplitText, input.readingWidth)
  const singlePane = sideBySide && content < input.listWidth + minSplitText + sides
  const beside = sideBySide && !singlePane
  const listWidthMax = beside
    ? input.listWidth + Math.max(0, Math.floor(content - input.listWidth - input.minSplitText - sides))
    : 0
  const listWidth = beside ? Math.min(listWidthMax, input.listWidth + Math.max(0, input.listGrow ?? 0)) : 0
  const pane = Math.max(0, content - listWidth)
  const textWidth = Math.max(0, Math.min(input.readingWidth, pane - sides))

  return { nav, navWidth, singlePane, listWidth, listWidthMax, textWidth, gutter: (pane - textWidth) / 2 }
}
