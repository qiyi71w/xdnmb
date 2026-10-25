import { describe, expect, it, vi } from 'vitest'
import { BUILTIN_PALETTES, over, parseColor, relativeLuminance, toHex, type Rgba } from '../../src/shared/theme'
import { onLayersChange, openLayer } from '../../src/renderer/src/lib/layers'
import { titleBarColors, type TitleBarLayer } from '../../src/renderer/src/lib/useAppearance'

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
