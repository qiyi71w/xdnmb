import { useLayoutEffect } from 'react'
import { resolveAppearance, type AppSettings } from '../../../shared/settings'

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
  const { scheme, variables } = resolveAppearance(settings, systemPrefersDark())
  for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value)
  root.style.setProperty('color-scheme', scheme)
  root.dataset.scheme = scheme
  root.dataset.density = settings.density
  if (settings.motion === 'reduce' || systemReducesMotion()) root.dataset.motion = 'reduce'
  else delete root.dataset.motion
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
