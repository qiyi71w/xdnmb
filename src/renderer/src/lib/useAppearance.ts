import { useLayoutEffect } from 'react'
import { resolveAppearance, type AppSettings } from '../../../shared/settings'
import { parseColor, toHex, type CustomTheme } from '../../../shared/theme'
import { PROTOTYPE_ENABLED } from '../features/directory/prototype/prototypeStore'

let preview: CustomTheme | null = null
let currentSettings: AppSettings | null = null

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
  if (PROTOTYPE_ENABLED) {
    const color = parseColor(variables['--window'] ?? '')
    const symbol = parseColor(variables['--ink'] ?? '')
    if (color !== null && symbol !== null) void window.xidao.view.updateTitleBar({ color: toHex(color), symbolColor: toHex(symbol), scheme: settings.colorScheme }).catch(() => undefined)
  }
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
