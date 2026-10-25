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

/**
 * The overlay as seen through modal backdrops (bottom to top): the window colour and its ink are
 * each composited under every backdrop, so the system controls dim with the rest of the window.
 */
export function dimmedTitleBar(color: Rgba, symbol: Rgba, backdrops: readonly Rgba[]): { color: string; symbolColor: string } {
  let background = { ...color, a: 1 }
  let ink = over(symbol, background)
  for (const backdrop of backdrops) {
    background = over(backdrop, background)
    ink = over(backdrop, ink)
  }
  return { color: toHex(background), symbolColor: toHex(ink) }
}

/** Backdrop colours actually drawn now (a transparent or unreadable backdrop adds nothing). */
function shownBackdrops(): Rgba[] {
  return modals.flatMap((dialog) => {
    const backdrop = parseColor(getComputedStyle(dialog, '::backdrop').backgroundColor)
    return backdrop !== null && backdrop.a > 0 ? [backdrop] : []
  })
}

function sendTitleBar(): void {
  if (titleBar === null) return
  const { color, symbolColor } = dimmedTitleBar(titleBar.color, titleBar.symbol, shownBackdrops())
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
