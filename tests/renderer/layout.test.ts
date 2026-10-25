import { describe, expect, it } from 'vitest'
import { computeLayout, type LayoutInput } from '../../src/renderer/src/features/layout/layout'

const base: LayoutInput = {
  width: 1500,
  view: 'split',
  navFull: 232,
  navCompactMin: 170,
  listWidth: 340,
  readingWidth: 672,
  minGutter: 20,
  minSplitText: 440,
  gap: 16
}
const at = (width: number, extra: Partial<LayoutInput> = {}) => computeLayout({ ...base, ...extra, width })

describe('responsive D layout order', () => {
  it('shrinks the reading gutters first, keeping full navigation, list and text width', () => {
    expect(at(1500)).toMatchObject({ nav: 'full', navWidth: 232, listWidth: 340, textWidth: 672, gutter: 120 })
    expect(at(1300)).toMatchObject({ nav: 'full', navWidth: 232, textWidth: 672, gutter: 20 })
  })

  it('then narrows the navigation continuously to its measured minimum without touching list or text', () => {
    expect(at(1299)).toMatchObject({ nav: 'compact', navWidth: 231, listWidth: 340, textWidth: 672, gutter: 20 })
    expect(at(1238)).toMatchObject({ nav: 'compact', navWidth: 170, navProgress: 1, textWidth: 672 })
  })

  it('then moves the navigation into an overlay; only after that may the text narrow, then single pane', () => {
    expect(at(1237)).toMatchObject({ nav: 'overlay', navWidth: 0, listWidth: 340, textWidth: 672, singlePane: false })
    expect(at(1000)).toMatchObject({ nav: 'overlay', listWidth: 340, textWidth: 604, singlePane: false })
    expect(at(836)).toMatchObject({ listWidth: 340, textWidth: 440, singlePane: false })
    expect(at(835)).toMatchObject({ listWidth: 0, singlePane: true, textWidth: 672 })
  })

  it('has no compact stage when the content needs the full navigation width to keep names complete', () => {
    expect(at(1299, { navCompactMin: 240 })).toMatchObject({ nav: 'overlay' })
  })

  it('uses the thresholds of what the entry shows: a whole-page reader keeps the navigation longer', () => {
    expect(at(1000, { view: 'reader' })).toMatchObject({ nav: 'full', listWidth: 0, textWidth: 672, singlePane: false })
    expect(at(900, { view: 'reader' })).toMatchObject({ nav: 'compact', textWidth: 672 })
  })

  it('takes a widened list from the reading text only, keeping the navigation and the split minimum', () => {
    expect(at(1500, { listGrow: 200 })).toMatchObject({ nav: 'full', listWidth: 540, listWidthMax: 772, textWidth: 672, gutter: 20 })
    expect(at(1500, { listGrow: 1000 })).toMatchObject({ nav: 'full', navWidth: 232, listWidth: 772, textWidth: 440 })
    expect(at(1000, { listGrow: 300 })).toMatchObject({ nav: 'overlay', listWidth: 504, textWidth: 440, singlePane: false })
    expect(at(835, { listGrow: 300 })).toMatchObject({ singlePane: true, listWidth: 0, listWidthMax: 0 })
  })
})
