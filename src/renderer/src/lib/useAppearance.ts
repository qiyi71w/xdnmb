import { useLayoutEffect } from 'react'
import { resolveAppearance, type AppSettings, type ColorScheme } from '../../../shared/settings'
import { over, parseColor, toHex, type CustomTheme, type Rgba } from '../../../shared/theme'
import { onLayersChange } from './layers'

let preview: CustomTheme | null = null
let currentSettings: AppSettings | null = null

// ---------- Title-bar overlay (Windows / Linux window controls drawn by the system) ----------

/** The window's own overlay colours: `--window` and `--ink` of the applied appearance. */
let titleBar: { color: Rgba; symbol: Rgba; scheme: ColorScheme } | null = null
/** Open modal dialogs in the order their backdrops stack (opening order). */
let modals: HTMLDialogElement[] = []
let modalWatch: MutationObserver | null = null
let sentTitleBar = ''

/** What lies over the window under the system controls, bottom to top. */
export type TitleBarLayer =
  /** A modal backdrop: dims the window and the controls' ink alike. */
  | { kind: 'backdrop'; color: Rgba }
  /** A surface drawn there over everything below (its backgrounds, bottom to top), in the app's ink. */
  | { kind: 'surface'; colors: readonly Rgba[] }

/**
 * The overlay as the window shows it under the controls: the window colour and its ink, with every
 * layer composited over them in order. A backdrop dims both; a surface (a viewer covering the
 * window with its own bar) replaces the colour with its own and brings back the undimmed ink.
 */
export function titleBarColors(color: Rgba, symbol: Rgba, layers: readonly TitleBarLayer[]): { color: string; symbolColor: string } {
  let background = { ...color, a: 1 }
  let ink = over(symbol, background)
  for (const layer of layers) {
    if (layer.kind === 'backdrop') {
      background = over(layer.color, background)
      ink = over(layer.color, ink)
    } else {
      for (const surface of layer.colors) background = over(surface, background)
      ink = over(symbol, background)
    }
  }
  return { color: toHex(background), symbolColor: toHex(ink) }
}

/** Marks the root of a layer that covers the window with its own surface (image viewers). */
const COVER = '[data-titlebar-cover]'

/** The part of the overlay the stylesheets reserve when the overlay reports no geometry (layout.css). */
const NOMINAL_CONTROLS = { width: 140, height: 44 }

/** The client-area rectangle beside the window controls (`navigator.windowControlsOverlay`). */
export interface TitleBarArea {
  x: number
  width: number
  height: number
}

/**
 * Where a cover is sampled for the colour under the window controls, in CSS pixels: across the
 * controls (to the right of the title-bar area), at the bottom pixel row of the part of them that
 * lies within the nominal 44px header. The controls keep their device height at every page zoom
 * while a cover's inset from the window edge and its top bar keep their CSS size, so at high zoom
 * the controls are only a few CSS pixels tall and their bottom row is the part that still lies on
 * such a surface, and at low zoom they reach below every cover's top bar (at least 44 CSS pixels
 * tall), so the sample stays at that bar's bottom row. Without overlay geometry, the middle of the
 * box the stylesheets reserve.
 */
export function controlsSamplePoint(viewportWidth: number, area: TitleBarArea | null): { x: number; y: number } {
  const left = area === null ? 0 : area.x + area.width
  if (area !== null && area.height > 0 && left < viewportWidth) {
    const bottom = Math.min(area.height, NOMINAL_CONTROLS.height)
    return { x: (left + viewportWidth) / 2, y: Math.max(bottom / 2, bottom - 0.5) }
  }
  return { x: viewportWidth - NOMINAL_CONTROLS.width / 2, y: NOMINAL_CONTROLS.height / 2 }
}

/** The Window Controls Overlay API (Chromium, enabled by `titleBarOverlay`); absent elsewhere. */
interface ControlsOverlay {
  readonly visible: boolean
  getTitlebarAreaRect(): DOMRect
}

/** A drawn background colour (a transparent or unreadable one adds nothing). */
function drawnColor(text: string): Rgba | null {
  const parsed = parseColor(text)
  return parsed !== null && parsed.a > 0 ? parsed : null
}

/**
 * The backgrounds a cover draws under the window controls, from its root down to the innermost box
 * there (its top bar); null when it does not reach them.
 */
function coverColors(root: Element): Rgba[] | null {
  const overlay = (navigator as Navigator & { windowControlsOverlay?: ControlsOverlay }).windowControlsOverlay
  const { x, y } = controlsSamplePoint(window.innerWidth, overlay?.visible === true ? overlay.getTitlebarAreaRect() : null)
  const contains = (element: Element) => {
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0 && x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom
  }
  if (!contains(root)) return null
  const colors: Rgba[] = []
  let element: Element | undefined = root
  while (element !== undefined) {
    const drawn = drawnColor(getComputedStyle(element).backgroundColor)
    if (drawn !== null) colors.push(drawn)
    element = [...element.children].findLast(contains)
  }
  return colors
}

/**
 * Layers under the controls now: in-page covers first (the post image viewer; under every modal),
 * then each modal dialog's backdrop and, when the dialog is a cover itself, its surface. A cover
 * hidden with its tab (zero size) adds nothing.
 */
function titleBarLayers(): TitleBarLayer[] {
  const layers: TitleBarLayer[] = []
  for (const root of document.querySelectorAll(COVER)) {
    if (root.closest('dialog') !== null) continue
    const colors = coverColors(root)
    if (colors !== null) layers.push({ kind: 'surface', colors })
  }
  for (const dialog of modals) {
    const backdrop = drawnColor(getComputedStyle(dialog, '::backdrop').backgroundColor)
    if (backdrop !== null) layers.push({ kind: 'backdrop', color: backdrop })
    const colors = dialog.matches(COVER) ? coverColors(dialog) : null
    if (colors !== null) layers.push({ kind: 'surface', colors })
  }
  return layers
}

function sendTitleBar(): void {
  if (titleBar === null) return
  const { color, symbolColor } = titleBarColors(titleBar.color, titleBar.symbol, titleBarLayers())
  const key = `${color} ${symbolColor} ${titleBar.scheme}`
  if (key === sentTitleBar) return
  sentTitleBar = key
  void window.xidao.view.updateTitleBar({ color, symbolColor, scheme: titleBar.scheme }).catch(() => {
    sentTitleBar = ''
  })
}

/** Re-reads which modal dialogs are open (a layer opened or closed, or a dialog's class changed). */
function trackModals(): void {
  const open = [...document.querySelectorAll<HTMLDialogElement>('dialog:modal')]
  modals = [...modals.filter((dialog) => open.includes(dialog)), ...open.filter((dialog) => !modals.includes(dialog))]
  // A dialog may show its backdrop later without a layer change (the quit dialog's `is-shown`).
  modalWatch ??= new MutationObserver(sendTitleBar)
  modalWatch.disconnect()
  for (const dialog of modals) modalWatch.observe(dialog, { attributes: true, attributeFilter: ['class'] })
  sendTitleBar()
}

function updateTitleBar(variables: Record<string, string>, scheme: ColorScheme): void {
  const color = parseColor(variables['--window'] ?? '')
  const symbol = parseColor(variables['--ink'] ?? '')
  if (color === null || symbol === null) return
  if (titleBar === null) {
    onLayersChange(trackModals)
    // Resizing and page zoom move the controls over a cover's other boxes.
    window.addEventListener('resize', sendTitleBar)
  }
  titleBar = { color, symbol, scheme }
  sendTitleBar()
}

/** Preview is renderer-only; clearing it restores the latest saved application appearance. */
export function previewTheme(theme: CustomTheme | null): void {
  preview = theme
  if (currentSettings !== null) applyAppearance(currentSettings)
}

const SYSTEM_DARK = '(prefers-color-scheme: dark)'
const SYSTEM_REDUCE = '(prefers-reduced-motion: reduce)'

/** Whether the operating system currently prefers a dark scheme. */
export function systemPrefersDark(): boolean {
  return window.matchMedia(SYSTEM_DARK).matches
}

/** Whether the operating system currently asks for reduced motion. */
export function systemReducesMotion(): boolean {
  return window.matchMedia(SYSTEM_REDUCE).matches
}

/**
 * Applies `settings` to the root element through the CSSOM (allowed by the CSP): the palette,
 * radii and reading variables computed by `resolveAppearance`, `color-scheme`, and the
 * `data-scheme`, `data-density` and `data-motion` attributes the stylesheets select on.
 * `data-motion="reduce"` is the effective value: the setting or the operating system.
 */
export function applyAppearance(settings: AppSettings): void {
  const root = document.documentElement
  currentSettings = settings
  const effective = preview === null ? settings : { ...settings, customTheme: preview, customThemeEnabled: true }
  const { scheme, variables } = resolveAppearance(effective, systemPrefersDark())
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value)
  root.style.setProperty('color-scheme', scheme)
  root.dataset.scheme = scheme
  root.dataset.density = settings.density
  if (settings.motion === 'reduce' || systemReducesMotion()) root.dataset.motion = 'reduce'
  else delete root.dataset.motion
  updateTitleBar(variables, settings.colorScheme)
}

/** Keeps the root element in step with `settings` and with live OS scheme / motion changes. */
export function useAppearance(settings: AppSettings): void {
  useLayoutEffect(() => {
    applyAppearance(settings)
    const queries = [window.matchMedia(SYSTEM_DARK), window.matchMedia(SYSTEM_REDUCE)]
    const onChange = () => applyAppearance(settings)
    for (const query of queries) query.addEventListener('change', onChange)
    return () => {
      for (const query of queries) query.removeEventListener('change', onChange)
    }
  }, [settings])
}
