import { useLayoutEffect } from 'react'
import { resolveAppearance, type AppSettings, type ColorScheme } from '../../../shared/settings'
import { over, parseColor, toHex, type CustomTheme, type Rgba } from '../../../shared/theme'
import { PROTOTYPE_ENABLED } from '../features/directory/prototype/prototypeStore'
import { onLayersChange } from './layers'

let preview: CustomTheme | null = null
let currentSettings: AppSettings | null = null

// ---------- PROTOTYPE: title-bar overlay (Windows/Linux controls drawn by the system) ----------

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

/** A drawn background colour (a transparent or unreadable one adds nothing). */
function drawnColor(text: string): Rgba | null {
  const parsed = parseColor(text)
  return parsed !== null && parsed.a > 0 ? parsed : null
}

/**
 * The backgrounds a cover draws under the controls (the window's top-right corner), from its root
 * down to the innermost box there (its top bar); null when it does not reach that corner.
 */
function coverColors(root: Element): Rgba[] | null {
  const x = window.innerWidth - 8
  const y = 8
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
 * Layers under the controls now: in-page covers first (the post image viewer, under every modal),
 * then each modal dialog's backdrop and, when the dialog is a cover itself, its surface.
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
  if (titleBar === null) onLayersChange(trackModals)
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
  if (PROTOTYPE_ENABLED) updateTitleBar(variables, settings.colorScheme)
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
