import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_PALETTES, over, parseColor, relativeLuminance, toHex, type Rgba } from '../../src/shared/theme'
import { onLayersChange, openLayer } from '../../src/renderer/src/lib/layers'
import { controlsSamplePoint, titleBarColors, type TitleBarArea, type TitleBarLayer } from '../../src/renderer/src/lib/useAppearance'

const color = (text: string) => {
  const parsed = parseColor(text)
  if (parsed === null) throw new Error(text)
  return parsed
}

// The compose panel's backdrops (editor.css) and the ordinary modal's (modal.css).
const COMPOSE = { light: color('oklch(0.2 0.02 240 / 0.45)'), dark: color('oklch(0.06 0.01 240 / 0.62)') }
const MODAL = color('oklch(0.2 0.02 240 / 0.22)')
const backdrop = (value: Rgba): TitleBarLayer => ({ kind: 'backdrop', color: value })

describe('title-bar overlay under modal backdrops', () => {
  it('is the window colour and its ink when nothing is open', () => {
    const { window, ink } = BUILTIN_PALETTES.light
    expect(titleBarColors(color(window), color(ink), [])).toEqual({ color: toHex(color(window)), symbolColor: toHex(color(ink)) })
  })

  it.each(['light', 'dark'] as const)('is the backdrop composited over --window and --ink (%s)', (scheme) => {
    const window = color(BUILTIN_PALETTES[scheme].window)
    const ink = color(BUILTIN_PALETTES[scheme].ink)
    const dimmed = titleBarColors(window, ink, [backdrop(COMPOSE[scheme])])
    expect(dimmed).toEqual({ color: toHex(over(COMPOSE[scheme], window)), symbolColor: toHex(over(COMPOSE[scheme], ink)) })
    expect(relativeLuminance(color(dimmed.color))).toBeLessThanOrEqual(relativeLuminance(window))
    expect(relativeLuminance(color(dimmed.symbolColor))).toBeLessThan(relativeLuminance(ink))
  })

  it('stacks backdrops in opening order', () => {
    const window = color(BUILTIN_PALETTES.light.window)
    const ink = color(BUILTIN_PALETTES.light.ink)
    expect(titleBarColors(window, ink, [backdrop(COMPOSE.light), backdrop(MODAL)]).color).toBe(toHex(over(MODAL, over(COMPOSE.light, window))))
  })

  it.each(['light', 'dark'] as const)('takes a covering surface over the dimmed window, with undimmed ink (%s)', (scheme) => {
    const window = color(BUILTIN_PALETTES[scheme].window)
    const ink = color(BUILTIN_PALETTES[scheme].ink)
    // The attachment preview over the compose panel: the viewer's frost, then its top bar.
    const frost = { ...window, a: 0.7 }
    const bar = { ...color(BUILTIN_PALETTES[scheme].paper), a: 0.72 }
    const below = over(COMPOSE[scheme], window)
    const surface = over(bar, over(frost, below))
    expect(titleBarColors(window, ink, [backdrop(COMPOSE[scheme]), { kind: 'surface', colors: [frost, bar] }])).toEqual({
      color: toHex(surface),
      symbolColor: toHex(over(ink, surface))
    })
  })

  it('dims a covering surface under a later backdrop', () => {
    const window = color(BUILTIN_PALETTES.light.window)
    const ink = color(BUILTIN_PALETTES.light.ink)
    const paper = color(BUILTIN_PALETTES.light.paper)
    const result = titleBarColors(window, ink, [{ kind: 'surface', colors: [paper] }, backdrop(MODAL)])
    expect(result).toEqual({ color: toHex(over(MODAL, paper)), symbolColor: toHex(over(MODAL, over(ink, paper))) })
  })
})

describe('title-bar cover sample point', () => {
  // A cover may sit 8 CSS px inside the window at every zoom, every viewer bar is at least 44 CSS px
  // tall; the controls (three 46px caption buttons, 44px tall) keep their device size, so they
  // shrink in CSS px as the page zooms in and grow past those bars as it zooms out.
  const inset = (viewport: number) => ({ left: 8, top: 8, right: viewport - 8, bottom: 8 + 44 })
  const inside = (point: { x: number; y: number }, box: { left: number; top: number; right: number; bottom: number }) =>
    point.x >= box.left && point.x < box.right && point.y >= box.top && point.y < box.bottom

  it.each([
    // Measured natively: the controls 88 CSS px tall, their bottom row below the 46px attachment bar.
    ['50%', 2640, { x: 0, width: 2640 - 276, height: 88 }],
    ['67%', 1980, { x: 0, width: 1980 - 207, height: 66 }],
    ['100%', 1320, { x: 0, width: 1320 - 138, height: 44 }],
    ['200%', 660, { x: 0, width: 660 - 69, height: 22 }],
    // Measured natively: the controls only 15 CSS px tall, their middle (7.5) above the paper.
    ['300%', 440, { x: 0, width: 440 - 46, height: 15 }]
  ] as const)('lands on the controls and on a surface inset from the window edge at %s zoom', (_zoom, viewport, area: TitleBarArea) => {
    const point = controlsSamplePoint(viewport, area)
    expect(inside(point, { left: area.x + area.width, top: 0, right: viewport, bottom: area.height })).toBe(true)
    expect(inside(point, inset(viewport))).toBe(true)
    // A viewer's top bar from the window's top edge.
    expect(inside(point, { left: 0, top: 0, right: viewport, bottom: 44 })).toBe(true)
  })

  it('falls back to the reserved box when the overlay reports no geometry', () => {
    for (const area of [null, { x: 0, width: 0, height: 0 }, { x: 0, width: 1320, height: 44 }]) {
      const point = controlsSamplePoint(1320, area)
      expect(inside(point, { left: 1320 - 140, top: 0, right: 1320, bottom: 44 })).toBe(true)
      expect(inside(point, inset(1320))).toBe(true)
    }
  })
})

describe('layer changes', () => {
  it('are heard once after the opening or closing code finishes', async () => {
    const listener = vi.fn()
    const stop = onLayersChange(listener)
    try {
      const first = openLayer()
      const second = openLayer()
      expect(listener).not.toHaveBeenCalled()
      await Promise.resolve()
      expect(listener).toHaveBeenCalledTimes(1)
      second.release()
      second.release()
      first.release()
      await Promise.resolve()
      expect(listener).toHaveBeenCalledTimes(2)
    } finally {
      stop()
    }
  })
})
